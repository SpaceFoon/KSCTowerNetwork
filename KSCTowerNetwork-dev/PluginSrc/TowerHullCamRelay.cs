using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Bridges JustReadTheInstructions (JRTI, https://github.com/RELMYMathieu/JustReadTheInstructions)
    /// HullCam JPEG snapshots into the KSC Tower backend so remote ground-control sees a live
    /// (~1 Hz) feed of the pilot's cameras over the public internet.
    ///
    /// Supported camera source: JRTI hooks the Hullcam VDS Continued <c>MuMechModuleHullCamera</c>
    /// PartModule. That module is also what Hullcam VDS attaches to docking ports, so the
    /// "docking cam" variants come along for free. Other camera mods (Neptune Camera's
    /// <c>ModuleNeptuneCamera</c>, KURS DockingCam) use their own PartModules and are NOT
    /// surfaced by JRTI — they will never appear in the relay even if the player has them
    /// installed. This is intentional; supporting them would require a native GPU readback
    /// path here that would duplicate (and have to maintain alongside) JRTI's internals.
    ///
    /// Flow:
    ///   1. Discovery coroutine GETs <c>{HullCamJrtiBaseUrl}/cameras</c> every 5 s.
    ///   2. Per discovered camera, the snapshot coroutine GETs <c>/camera/{id}/snapshot</c>
    ///      at 1 (or 2) Hz; calling /snapshot also "marks snapshot interest" on JRTI's side
    ///      so it keeps doing the GPU readback for us.
    ///   3. The JPEG bytes are POSTed to <c>{ApiBaseUrl}/hullcam/{SessionId}/{cameraId}</c>
    ///      with <c>Content-Type: image/jpeg</c> and the existing tower bearer token.
    ///
    /// The whole MonoBehaviour is Flight-scene scoped (auto-unloaded by KSP outside flight),
    /// matching <see cref="TowerTelemetryPublisher"/>.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerHullCamRelay : MonoBehaviour
    {
        // Discovery cadence. JRTI rebuilds the camera list as parts are added/removed; 5 s is
        // plenty since pilots rarely hot-swap cameras mid-flight.
        private const float DiscoveryIntervalSeconds = 5f;
        // Long back-off when JRTI isn't reachable (mod not installed, scene not flight, etc.)
        // so we stop hammering the local socket every 5 s for a port that will never answer.
        private const float DiscoveryBackoffSeconds = 30f;
        private const int MaxCamerasTracked = 16;

        private readonly Dictionary<int, CameraSlot> _slots = new Dictionary<int, CameraSlot>();
        private bool _started;
        private bool _jrtiUnreachable;
        private int _consecutiveJrtiFailures;

        /// <summary>
        /// Last reachability state of JRTI's local HTTP listener as observed by the
        /// most recent discovery probe. False both when JRTI is not installed and
        /// when its socket is failing right now. Surfaced via the per-tick
        /// <c>subsystems.hullcam</c> telemetry block so the tower controller can
        /// see "pilot toggled HullCam on but JRTI is down" at a glance.
        /// </summary>
        public static bool JrtiReachable { get; private set; }

        /// <summary>
        /// Number of cameras the relay is currently tracking (snapshot loops
        /// running). Zero when JRTI is unreachable, the player toggle is off, or
        /// the active vessel simply has no Hullcam-equipped parts. Updated
        /// whenever <see cref="_slots"/> changes.
        /// </summary>
        public static int LiveCameraCount { get; private set; }

        private sealed class CameraSlot
        {
            public int Id;
            public string Name = string.Empty;
            public bool LoopRunning;
        }

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(DiscoveryLoop());
        }

        private IEnumerator DiscoveryLoop()
        {
            // Small initial delay so flight scene has time to settle and JRTI can spin its
            // HttpListener before we start probing.
            yield return new WaitForSeconds(2f);

            while (true)
            {
                if (!ShouldRun())
                {
                    yield return new WaitForSeconds(DiscoveryIntervalSeconds);
                    continue;
                }

                yield return StartCoroutine(DiscoverCameras());

                var wait = _jrtiUnreachable ? DiscoveryBackoffSeconds : DiscoveryIntervalSeconds;
                yield return new WaitForSeconds(wait);
            }
        }

        /// <summary>
        /// Mirror the relay's instance-scoped slot count and JRTI reachability
        /// onto the public statics consumed by <c>TowerTelemetryPublisher</c>.
        /// Called wherever <see cref="_slots"/> or <see cref="_jrtiUnreachable"/>
        /// transitions, plus on shutdown so the tower doesn't think we still
        /// have N cameras live after the player exits flight.
        /// </summary>
        private void PublishSubsystemState()
        {
            JrtiReachable = !_jrtiUnreachable;
            LiveCameraCount = _slots.Count;
        }

        private void OnDestroy()
        {
            // Scene tear-down — make absolutely sure the tower stops seeing this
            // pilot as "streaming N cameras" once the relay MonoBehaviour goes
            // away. Mirrors the SceneLeft status-edge that TowerTelemetryPublisher
            // pushes for the same reason.
            JrtiReachable = false;
            LiveCameraCount = 0;
        }

        private bool ShouldRun()
        {
            if (!TowerModSettings.EnableHullCamRelay)
            {
                // Toggle was flipped off mid-flight; tear down per-camera loops by clearing slots
                // (the per-camera coroutines will exit on their own when the slot disappears).
                if (_slots.Count > 0)
                {
                    _slots.Clear();
                    PublishSubsystemState();
                }
                return false;
            }

            if (!FlightGlobals.ready || FlightGlobals.ActiveVessel == null)
            {
                return false;
            }

            if (FlightGlobals.ActiveVessel.state == Vessel.State.DEAD)
            {
                return false;
            }

            // Backend rejects telemetry/hullcam without a pilot identity; bail early.
            if (string.IsNullOrWhiteSpace(TowerVesselCallsignStore.GetEffectivePilotCallsign(FlightGlobals.ActiveVessel)))
            {
                return false;
            }

            return true;
        }

        private IEnumerator DiscoverCameras()
        {
            var url = TowerModSettings.HullCamJrtiBaseUrl + "/cameras";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 3;
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    HandleJrtiUnreachable("network: " + req.error);
                    yield break;
                }

                if (req.isHttpError)
                {
                    // 404 here usually means JRTI isn't routing /cameras (wrong port / wrong mod);
                    // treat as unreachable but with a quieter log line.
                    HandleJrtiUnreachable("http " + req.responseCode);
                    yield break;
                }

                _consecutiveJrtiFailures = 0;
                _jrtiUnreachable = false;

                var body = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                ApplyDiscoveryResult(body);
                PublishSubsystemState();
            }
        }

        private void HandleJrtiUnreachable(string reason)
        {
            _consecutiveJrtiFailures++;
            // Only log on transition from reachable -> unreachable so we don't spam on every probe
            // when JRTI just isn't installed.
            if (!_jrtiUnreachable)
            {
                Debug.Log("[KSCTowerNetwork] JRTI HullCam relay backing off (" + reason + ")");
            }
            _jrtiUnreachable = true;

            if (_slots.Count > 0)
            {
                _slots.Clear();
            }
            PublishSubsystemState();
        }

        /// <summary>
        /// Parses the minimal JRTI <c>/cameras</c> JSON shape <c>[{"id":N,"name":"…",…},…]</c>
        /// without dragging in a JSON dependency. Mirrors the string-scan approach used by
        /// <see cref="TowerTelemetryPublisher"/>'s countdown parser.
        /// </summary>
        private void ApplyDiscoveryResult(string json)
        {
            var found = new HashSet<int>();
            ParseCamerasJson(json, found);

            // Drop slots for cameras that disappeared from the active vessel.
            if (_slots.Count > 0)
            {
                List<int> toRemove = null;
                foreach (var key in _slots.Keys)
                {
                    if (!found.Contains(key))
                    {
                        (toRemove ?? (toRemove = new List<int>())).Add(key);
                    }
                }
                if (toRemove != null)
                {
                    for (int i = 0; i < toRemove.Count; i++)
                    {
                        _slots.Remove(toRemove[i]);
                    }
                }
            }
        }

        private void ParseCamerasJson(string json, HashSet<int> foundOut)
        {
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            int p = 0;
            int safety = 0;
            while (p < json.Length && safety++ < 256)
            {
                var braceOpen = json.IndexOf('{', p);
                if (braceOpen < 0)
                {
                    break;
                }

                int depth = 0;
                int braceClose = -1;
                for (int i = braceOpen; i < json.Length; i++)
                {
                    if (json[i] == '{')
                    {
                        depth++;
                    }
                    else if (json[i] == '}')
                    {
                        depth--;
                        if (depth == 0)
                        {
                            braceClose = i;
                            break;
                        }
                    }
                }

                if (braceClose < 0)
                {
                    break;
                }

                var entry = json.Substring(braceOpen, braceClose - braceOpen + 1);
                p = braceClose + 1;

                int camId;
                if (!TryReadJsonInt(entry, "\"id\"", out camId))
                {
                    continue;
                }

                if (foundOut.Count >= MaxCamerasTracked)
                {
                    continue;
                }

                var camName = TryReadJsonString(entry, "\"name\"") ?? ("Cam " + camId);
                foundOut.Add(camId);

                CameraSlot slot;
                if (!_slots.TryGetValue(camId, out slot))
                {
                    slot = new CameraSlot { Id = camId, Name = camName };
                    _slots[camId] = slot;
                }
                else
                {
                    slot.Name = camName;
                }

                if (!slot.LoopRunning)
                {
                    slot.LoopRunning = true;
                    StartCoroutine(SnapshotLoop(slot));
                }
            }
        }

        private IEnumerator SnapshotLoop(CameraSlot slot)
        {
            try
            {
                while (true)
                {
                    var fps = Mathf.Clamp(TowerModSettings.HullCamFps, 1, 2);
                    var period = 1f / fps;

                    if (!ShouldRun() || _jrtiUnreachable || !_slots.ContainsKey(slot.Id))
                    {
                        yield break;
                    }

                    yield return StartCoroutine(PollAndPushFrame(slot));
                    yield return new WaitForSeconds(period);
                }
            }
            finally
            {
                slot.LoopRunning = false;
            }
        }

        private IEnumerator PollAndPushFrame(CameraSlot slot)
        {
            var snapshotUrl = TowerModSettings.HullCamJrtiBaseUrl + "/camera/" + slot.Id + "/snapshot";
            byte[] jpeg = null;

            using (var req = UnityWebRequest.Get(snapshotUrl))
            {
                req.timeout = 4;
                req.downloadHandler = new DownloadHandlerBuffer();
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    HandleJrtiUnreachable("snapshot network: " + req.error);
                    yield break;
                }

                if (req.responseCode == 503)
                {
                    // JRTI hasn't produced a frame yet (just opened); skip silently.
                    yield break;
                }

                if (req.isHttpError)
                {
                    if (req.responseCode == 404)
                    {
                        // Camera vanished mid-flight (vessel switch, part removed). Drop slot;
                        // discovery will re-add if it comes back.
                        _slots.Remove(slot.Id);
                        PublishSubsystemState();
                    }
                    yield break;
                }

                jpeg = req.downloadHandler != null ? req.downloadHandler.data : null;
            }

            if (jpeg == null || jpeg.Length < 4)
            {
                yield break;
            }

            // Drop oversize frames (typically only happens with a custom JRTI render res); the
            // backend body limit is 512 KB and we keep our own limit lower as headroom.
            if (jpeg.Length > TowerModSettings.HullCamMaxBytes)
            {
                yield break;
            }

            yield return StartCoroutine(UploadFrame(slot, jpeg));
        }

        private IEnumerator UploadFrame(CameraSlot slot, byte[] jpeg)
        {
            // When the player has flipped on "Stream as Tower" we re-target the upload to the
            // dedicated KSC-TOWER-* hullcam namespace (see hullcamStore.isKscTowerSessionId).
            // That namespace is intentionally session-rowless on the backend so this stream
            // never enters the lobby/queue/scoring graph — it's purely a "look out the tower
            // window" feed for other pilots' Tower View tile. Otherwise we use the active
            // channel session id like every other relay.
            var publishSessionId = TowerModSettings.StreamAsTower
                ? TowerModSettings.TowerStreamSessionId
                : TowerModSettings.SessionId;

            // ApiBaseUrl already includes the /v1 prefix.
            var url = TowerModSettings.ApiBaseUrl + "/hullcam/"
                + UrlEncode(publishSessionId) + "/" + slot.Id;

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(jpeg);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "image/jpeg");
                req.SetRequestHeader("X-Camera-Name", UrlEncode(slot.Name ?? string.Empty));
                req.timeout = 6;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    // Tower backend offline; quiet log so this isn't spammy.
                    yield break;
                }

                if (req.isHttpError)
                {
                    // 401/403/404 means the session/auth is misaligned. Log once per code so
                    // we don't drown the player log with 1 Hz repeats.
                    if (Time.unscaledTime - _lastHttpErrorLog > 30f)
                    {
                        _lastHttpErrorLog = Time.unscaledTime;
                        Debug.LogWarning("[KSCTowerNetwork] HullCam upload "
                            + req.responseCode + ": " + (req.error ?? string.Empty));
                    }
                    yield break;
                }
            }
        }

        private float _lastHttpErrorLog;

        private static bool TryReadJsonInt(string json, string quotedKey, out int value)
        {
            value = 0;
            var i = json.IndexOf(quotedKey, StringComparison.Ordinal);
            if (i < 0)
            {
                return false;
            }

            var colon = json.IndexOf(':', i + quotedKey.Length);
            if (colon < 0)
            {
                return false;
            }

            int p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            int start = p;
            if (p < json.Length && json[p] == '-')
            {
                p++;
            }

            while (p < json.Length && char.IsDigit(json[p]))
            {
                p++;
            }

            if (p <= start)
            {
                return false;
            }

            return int.TryParse(
                json.Substring(start, p - start),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out value);
        }

        /// <summary>
        /// Reads a JSON string value for <paramref name="quotedKey"/>. Handles standard escapes
        /// (\\, \", \n, \r, \t) so JRTI camera names like <c>Service-Bay "Cam"</c> survive.
        /// Returns null when the key is missing or the value isn't a string.
        /// </summary>
        private static string TryReadJsonString(string json, string quotedKey)
        {
            var i = json.IndexOf(quotedKey, StringComparison.Ordinal);
            if (i < 0)
            {
                return null;
            }

            var colon = json.IndexOf(':', i + quotedKey.Length);
            if (colon < 0)
            {
                return null;
            }

            int p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            if (p >= json.Length || json[p] != '"')
            {
                return null;
            }

            p++;
            var sb = new StringBuilder(32);
            while (p < json.Length)
            {
                char c = json[p];
                if (c == '\\' && p + 1 < json.Length)
                {
                    char n = json[p + 1];
                    switch (n)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        default: sb.Append(n); break;
                    }
                    p += 2;
                    continue;
                }

                if (c == '"')
                {
                    return sb.ToString();
                }

                sb.Append(c);
                p++;
            }

            return null;
        }

        private static string UrlEncode(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            return UnityWebRequest.EscapeURL(s);
        }
    }
}
