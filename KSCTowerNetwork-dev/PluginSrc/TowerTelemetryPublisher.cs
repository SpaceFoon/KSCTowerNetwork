using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Posts flight telemetry to the Tower backend for the tower web app / assigned controllers.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerTelemetryPublisher : MonoBehaviour
    {
        private float _nextIntervalSeconds = 5f;
        private bool _started;

        // ---------------------------------------------------------------------
        // Adaptive-cadence state. The publisher normally sleeps for whatever
        // `nextTelemetrySeconds` the backend last suggested (5 s by default),
        // but during "hot" flight regimes — the pattern, the flare, hard
        // maneuvering, throttle slams — we shorten the wait so the controller
        // (and the ghost-fleet predictor on every other client) sees the truth
        // catch up to the pilot's actual track within a few hundred ms instead
        // of every couple of seconds.
        //
        // Cruise cadence is unchanged: an airliner at FL300 cruising straight
        // still posts on the server's preferred interval.
        // ---------------------------------------------------------------------

        /// <summary>Floor for the adaptive interval (s). 2 Hz max even in the worst case.</summary>
        private const float MinIntervalBoostSeconds = 0.5f;
        /// <summary>Floor used when no boost rule fires (the prior fixed-clamp behavior).</summary>
        private const float MinIntervalCruiseSeconds = 2f;
        /// <summary>Hard ceiling — long-haul cruise still pings at least once a minute.</summary>
        private const float MaxIntervalSeconds = 60f;

        /// <summary>
        /// Throttle from the previous loop tick, used to detect "the pilot is actively
        /// managing power" (a non-trivial change between samples). Null until the second
        /// loop tick so the very first sample can't be misread as a slam from the 0 default.
        /// </summary>
        private float _prevThrottle;
        private bool _hasPrevThrottle;

        /// <summary>
        /// Peak <see cref="Vessel.geeForce"/> seen since the publisher came up. Reset on
        /// scene entry (each new flight gets its own max) so the controller's strip can
        /// surface "this airframe pulled 7.2g during the climb" without us having to
        /// stream every per-tick g sample.
        /// </summary>
        private double _maxGLoadThisFlight;

        /// <summary>
        /// Last <see cref="TelemetryGoneDarkReason"/> we POSTed to the backend (or
        /// <see cref="TelemetryGoneDarkReason.None"/> when the most recent action was a
        /// successful telemetry sample, which the backend treats as an implicit "live").
        /// Tracking this lets us push exactly one status POST per state edge instead of
        /// hammering the endpoint every <see cref="TelemetryLoop"/> tick while the player
        /// sits with the beacon off.
        /// </summary>
        private TelemetryGoneDarkReason _lastReportedDark = TelemetryGoneDarkReason.None;

        // --- Smoothed position (additive; raw lat/lon/asl stay authoritative for scoring) ---
        private const float PositionSmoothAlpha = 0.2f;
        private const double PositionTeleportResetDeg = 0.0045d;
        private uint _smoothPid;
        private bool _hasSmoothedSample;
        private double _smoothLat;
        private double _smoothLon;
        private double _smoothAslAlt;

        // --- Auto callouts (session chat; debounced) ---
        private float _nextCalloutAllowedUnscaled = -1f;
        private int _calloutRungMax;

        private double _lastEmitDistKscM;
        private bool _lastEmitOnApproach;
        private bool _lastEmitLanding;
        private uint _lastActiveVesselPid;
        private bool _hasLastActiveVesselPid;

        /// <summary>
        /// Reasons the publisher might deliberately not send a telemetry sample. Mirrors
        /// the backend's <c>telemetryStatusSchema</c>; do not extend without updating both.
        /// </summary>
        private enum TelemetryGoneDarkReason
        {
            None = 0,
            BeaconOff,
            Paused,
            Warp,
            VesselDead,
            VesselSwitch,
            SceneLeft
        }

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(TelemetryLoop());
        }

        /// <summary>
        /// MonoBehaviour shutdown — fires when the player exits the Flight scene (revert,
        /// recover, return to Space Center, quit to main menu, alt-F4 of the scene only).
        /// Use it to push a final "scene_left" status so the tower stops pretending the
        /// frozen last sample is live. We can't run a coroutine here (the GameObject is
        /// being torn down), so the helper does a fire-and-forget UnityWebRequest from
        /// the persistent <see cref="TowerMainThreadDispatcher"/>.
        /// </summary>
        private void OnDestroy()
        {
            // If we never spoke at all (e.g. pilot name unset, no flight ever happened)
            // there's no controller-side stale state to clear; skip the round-trip.
            if (_lastReportedDark == TelemetryGoneDarkReason.SceneLeft)
            {
                return;
            }

            TryPostStatusFromTeardown(
                TelemetryGoneDarkReason.SceneLeft,
                "Pilot exited flight scene"
            );
        }

        private IEnumerator TelemetryLoop()
        {
            // Realtime waits: KSP flight pause drives `Time.timeScale` to 0. Scaled
            // `WaitForSeconds` never completes, so telemetry stops and the tower
            // derives `stale` / "connection lost". Unscaled waits keep heartbeats
            // going while the sim is frozen.
            yield return new WaitForSecondsRealtime(1f);
            while (true)
            {
                // Adaptive cadence: when the active vessel is in a hot regime
                // (low AGL, hard control input, throttle slamming, fast vertical
                // motion) we shorten the wait so the next sample arrives quickly
                // enough that the ghost-fleet predictor stays on track. Falls
                // back to the server-suggested interval otherwise.
                var wait = ComputeAdaptiveInterval(FlightGlobals.ActiveVessel, _nextIntervalSeconds);
                yield return new WaitForSecondsRealtime(wait);

                if (!FlightGlobals.ready || FlightGlobals.ActiveVessel == null)
                {
                    continue;
                }

                var v = FlightGlobals.ActiveVessel;
                if (v.state == Vessel.State.DEAD)
                {
                    yield return StartCoroutine(MaybePostGoneDark(
                        TelemetryGoneDarkReason.VesselDead,
                        "Active vessel destroyed"));
                    continue;
                }

                if (string.IsNullOrWhiteSpace(TowerVesselCallsignStore.GetEffectivePilotCallsign(v)))
                {
                    continue;
                }

                // Stream-as-Tower mode: this client is the "look out the tower window" hullcam
                // streamer, not a pilot in the lobby. We deliberately publish nothing — neither
                // a telemetry sample nor a gone-dark status — because we don't want this player
                // to appear in the ghost fleet AND as a tower view simultaneously, and the
                // backend rejects telemetry under KSC-TOWER-* session ids anyway. The toggle
                // also forces BeaconActive=false on activation, so the radio LED stays in sync.
                if (TowerModSettings.StreamAsTower)
                {
                    continue;
                }

                // "Beacon" master switch (radio panel + auth.cfg). When the player turns the beacon
                // off we stop POSTing telemetry samples — but we *do* push one explicit
                // `beacon_off` status so the controller's screen renders "BEACON OFF" instead of
                // freezing on the last sample with no explanation.
                if (!TowerModSettings.BeaconActive)
                {
                    yield return StartCoroutine(MaybePostGoneDark(
                        TelemetryGoneDarkReason.BeaconOff,
                        "Pilot disabled telemetry beacon"));
                    continue;
                }

                // On-rails (high) time warp: position/heading/biome are all garbage during warp
                // and the telemetry sample would lie about the pilot's actual state. Pause the
                // sample stream and surface "WARP Nx" on the tower instead. PHYSICS warp keeps
                // posting because the values are still meaningful.
                if (TimeWarp.CurrentRate > 1.001f && TimeWarp.WarpMode == TimeWarp.Modes.HIGH)
                {
                    var rate = TimeWarp.CurrentRate;
                    yield return StartCoroutine(MaybePostGoneDark(
                        TelemetryGoneDarkReason.Warp,
                        "On-rails time warp " + rate.ToString("0.##", CultureInfo.InvariantCulture) + "x"));
                    continue;
                }

                // Flight pause freezes simulation updates (timeScale = 0), so samples stop
                // being meaningful until the player unpauses.
                if (IsGamePaused())
                {
                    yield return StartCoroutine(MaybePostGoneDark(
                        TelemetryGoneDarkReason.Paused,
                        "Game paused"));
                    continue;
                }

                var pid = unchecked((uint)v.persistentId);
                if (_hasLastActiveVesselPid && pid != _lastActiveVesselPid)
                {
                    _lastActiveVesselPid = pid;
                    var vesselName = string.IsNullOrEmpty(v.vesselName) ? "unknown vessel" : v.vesselName;
                    yield return StartCoroutine(MaybePostGoneDark(
                        TelemetryGoneDarkReason.VesselSwitch,
                        "Pilot switched active vessel to " + vesselName));
                    continue;
                }
                _lastActiveVesselPid = pid;
                _hasLastActiveVesselPid = true;

                var json = BuildTelemetryJson(v);
                MaybeQueueFlightCallouts(v);
                yield return StartCoroutine(PostTelemetry(json));
            }
        }

        private static bool IsGamePaused()
        {
            // KSP flight pause drives `Time.timeScale` to 0. Keep this check narrow:
            // on-rails warp is handled separately above and physics-warp keeps >0.
            return Time.timeScale <= 0.0001f;
        }

        /// <summary>
        /// Pick the next sleep duration based on what the active vessel is currently doing.
        /// The server-suggested interval (<paramref name="serverSuggested"/>) is the upper
        /// bound; each boost rule below can only <em>shorten</em> it, never lengthen it.
        ///
        /// Boost regimes (any one fires):
        /// <list type="bullet">
        ///   <item><b>Low AGL</b> — &lt;150 m → 0.5 s, &lt;500 m → 1 s, &lt;2 km → 1.5 s.
        ///         Pattern / final / flare is where prediction error matters most because the
        ///         player can <em>see</em> the ghost relative to the ground.</item>
        ///   <item><b>Stick deflection</b> — combined |pitch|+|yaw|+|roll| input. &gt;0.5 → 0.75 s,
        ///         &gt;0.15 → 1.5 s. Includes SAS-driven correction (the autopilot fighting
        ///         counts as "vessel attitude is changing", which is what we care about).</item>
        ///   <item><b>Throttle slam</b> — Δthrottle &gt; 0.15 between samples → 1 s. Catches
        ///         go-around throttle pushes and engine-out idle sweeps.</item>
        ///   <item><b>High vertical speed</b> — |VS| &gt; 30 m/s → 1.5 s. Climbs and dives
        ///         drift fast in the alt axis between snapshots.</item>
        /// </list>
        ///
        /// Floored at <see cref="MinIntervalBoostSeconds"/> (2 Hz) so even a perfect-storm
        /// landing in a wing-rocking hover-jet can't melt the backend, and ceilinged at
        /// <see cref="MaxIntervalSeconds"/> so the cruise tick still shows up.
        /// </summary>
        private float ComputeAdaptiveInterval(Vessel v, float serverSuggested)
        {
            // No vessel yet (early flight tick, scene not settled): respect the server
            // hint with the cruise floor — no point boosting when there's nothing to
            // sample.
            if (v == null)
            {
                return Mathf.Clamp(serverSuggested, MinIntervalCruiseSeconds, MaxIntervalSeconds);
            }

            float interval = serverSuggested;

            // 1. Low AGL — the most important boost rule by far. A pilot in the flare
            // moves ~30 m/s while the ground is right there; without aggressive sampling
            // every other player would see them ghosting through the runway centerline.
            // radarAltitude is -1/NaN for vessels without ground reference (in space) so
            // gate on positive finite values.
            var radar = v.radarAltitude;
            if (radar > 0 && !double.IsNaN(radar) && !double.IsInfinity(radar))
            {
                if (radar < 150) interval = Mathf.Min(interval, 0.5f);
                else if (radar < 500) interval = Mathf.Min(interval, 1.0f);
                else if (radar < 2000) interval = Mathf.Min(interval, 1.5f);
            }

            // 2. Active stick input. ctrlState already aggregates user + SAS + trim, which
            // is exactly the "is this airframe currently changing attitude?" signal we want.
            var ctrl = v.ctrlState;
            if (ctrl != null)
            {
                float inputMag = Mathf.Abs(ctrl.pitch) + Mathf.Abs(ctrl.yaw) + Mathf.Abs(ctrl.roll);
                if (inputMag > 0.5f) interval = Mathf.Min(interval, 0.75f);
                else if (inputMag > 0.15f) interval = Mathf.Min(interval, 1.5f);

                // 3. Throttle slam (vs. previous sample, not vs. some absolute value — a
                // pilot sitting at 100% throttle for the climb shouldn't trigger this).
                if (_hasPrevThrottle)
                {
                    float dThrottle = Mathf.Abs(ctrl.mainThrottle - _prevThrottle);
                    if (dThrottle > 0.15f) interval = Mathf.Min(interval, 1.0f);
                }
                _prevThrottle = ctrl.mainThrottle;
                _hasPrevThrottle = true;
            }

            // 4. High vertical speed — fast climbs/dives drift in altitude between
            // snapshots even when the lateral track is steady.
            if (Math.Abs(v.verticalSpeed) > 30.0)
            {
                interval = Mathf.Min(interval, 1.5f);
            }

            // Final clamp: boost floor (0.5 s = 2 Hz) on the bottom, cruise ceiling on top.
            return Mathf.Clamp(interval, MinIntervalBoostSeconds, MaxIntervalSeconds);
        }

        /// <summary>
        /// Push a status POST exactly once per state edge. While we sit in the same dark
        /// reason (e.g. beacon off for 30 minutes) we stay quiet so the endpoint isn't
        /// hammered. The loop calls this on every tick so transitioning back to live
        /// happens implicitly the next time <see cref="PostTelemetry"/> succeeds (the
        /// backend clears the stored status on every fresh sample).
        /// </summary>
        private IEnumerator MaybePostGoneDark(TelemetryGoneDarkReason reason, string message)
        {
            if (_lastReportedDark == reason)
            {
                yield break;
            }

            yield return StartCoroutine(PostTelemetryStatus(reason, message));
        }

        private IEnumerator PostTelemetryStatus(TelemetryGoneDarkReason reason, string message)
        {
            var stateName = ReasonWireName(reason);
            if (stateName == null)
            {
                yield break;
            }

            var json = "{\"state\":\"" + stateName + "\",\"message\":\"" + JsonEscape(message ?? string.Empty) + "\"}";
            if (TowerModSettings.UseUdpLiveTransport)
            {
                string udpReply;
                string udpError;
                if (TowerUdpClient.TryRequest(
                        TowerUdpMessageType.TelemetryStatus,
                        TowerModSettings.SessionId,
                        json,
                        out udpReply,
                        out udpError))
                {
                    _lastReportedDark = reason;
                    yield break;
                }

                if (!TowerModSettings.LiveUdpFallbackHttp)
                {
                    if (!string.IsNullOrEmpty(udpError))
                    {
                        Debug.LogWarning("[KSCTowerNetwork] telemetry-status UDP failed (" + stateName + "): " + udpError);
                    }
                    yield break;
                }
            }

            var url = TowerModSettings.ApiBaseUrl + "/telemetry-status/" + TowerModSettings.SessionId;
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] telemetry-status POST failed (" + stateName + "): " + req.error);
                    // Don't update _lastReportedDark on failure — we want the next loop tick
                    // to retry so the controller eventually sees the right state instead of
                    // being permanently stuck in "live" because one packet got dropped.
                    yield break;
                }
            }

            _lastReportedDark = reason;
        }

        /// <summary>
        /// Best-effort fire-and-forget status POST from <see cref="OnDestroy"/>, where we
        /// can't start a coroutine on a MonoBehaviour that's about to be torn down. Hands
        /// the work to the persistent <see cref="TowerMainThreadDispatcher"/>, which lives
        /// across scene loads. If the dispatcher isn't ready yet (extremely-early
        /// shutdown) we silently drop — the backend's stale-detection will still light up
        /// "stale" within ~15s anyway.
        /// </summary>
        private void TryPostStatusFromTeardown(TelemetryGoneDarkReason reason, string message)
        {
            var stateName = ReasonWireName(reason);
            if (stateName == null || string.IsNullOrEmpty(TowerModSettings.SessionId))
            {
                return;
            }

            // Capture settings on the dying thread; the dispatcher resumes on the main
            // thread next Update tick, by which point TowerModSettings is still valid
            // (it's a static singleton) but the captured strings ensure no surprise.
            var url = TowerModSettings.ApiBaseUrl + "/telemetry-status/" + TowerModSettings.SessionId;
            var token = TowerModSettings.TowerAuthToken;
            var json = "{\"state\":\"" + stateName + "\",\"message\":\"" + JsonEscape(message ?? string.Empty) + "\"}";

            TowerMainThreadDispatcher.Run(() =>
            {
                var dispatcher = TowerMainThreadDispatcher.IsReady
                    ? UnityEngine.Object.FindObjectOfType<TowerMainThreadDispatcher>()
                    : null;
                if (dispatcher == null)
                {
                    return;
                }

                dispatcher.StartCoroutine(SendStatusOneShot(url, token, json));
            });
        }

        private static IEnumerator SendStatusOneShot(string url, string bearerToken, string json)
        {
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 4;
                if (!string.IsNullOrEmpty(bearerToken))
                {
                    req.SetRequestHeader("Authorization", "Bearer " + bearerToken);
                }

                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] teardown telemetry-status POST failed: " + req.error);
                }
            }
        }

        private static string ReasonWireName(TelemetryGoneDarkReason reason)
        {
            switch (reason)
            {
                case TelemetryGoneDarkReason.BeaconOff: return "beacon_off";
                case TelemetryGoneDarkReason.Paused: return "paused";
                case TelemetryGoneDarkReason.Warp: return "warp";
                case TelemetryGoneDarkReason.VesselDead: return "vessel_dead";
                case TelemetryGoneDarkReason.VesselSwitch: return "vessel_switch";
                case TelemetryGoneDarkReason.SceneLeft: return "scene_left";
                default: return null;
            }
        }

        private IEnumerator PostTelemetry(string json)
        {
            if (TowerModSettings.UseUdpLiveTransport)
            {
                string udpReply;
                string udpError;
                if (TowerUdpClient.TryRequest(
                        TowerUdpMessageType.TelemetrySample,
                        TowerModSettings.SessionId,
                        json,
                        out udpReply,
                        out udpError))
                {
                    // Backend clears telemetryStatus on each fresh sample.
                    _lastReportedDark = TelemetryGoneDarkReason.None;
                    ParseNextInterval(udpReply);
                    ParseCountdown(udpReply);
                    ParseClearances(udpReply);
                    ParseTakeoffClearance(udpReply);
                    ParseRadioState(udpReply);
                    yield break;
                }

                if (!TowerModSettings.LiveUdpFallbackHttp)
                {
                    if (!string.IsNullOrEmpty(udpError))
                    {
                        Debug.LogWarning("[KSCTowerNetwork] telemetry UDP failed: " + udpError);
                    }
                    _nextIntervalSeconds = 8f;
                    yield break;
                }
            }

            var url = TowerModSettings.ApiBaseUrl + "/telemetry/" + TowerModSettings.SessionId;
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] telemetry POST failed: " + req.error);
                    _nextIntervalSeconds = 8f;
                    yield break;
                }

                // Backend clears its stored `telemetryStatus` on every fresh sample, so
                // the controller is implicitly back to "live". Mirror that locally so the
                // next time we go dark (player flips beacon off again, etc.) the edge
                // detector fires another status POST instead of staying silent.
                _lastReportedDark = TelemetryGoneDarkReason.None;

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                ParseNextInterval(text);
                ParseCountdown(text);
                ParseClearances(text);
                ParseTakeoffClearance(text);
                ParseRadioState(text);
            }
        }

        /// <summary>
        /// Pull <c>countdown.startsAtMs</c>, <c>countdown.lengthSec</c>, and the response's
        /// <c>serverNowMs</c> into <see cref="TowerCountdownState"/> so the in-game HUD can
        /// render a synced T-minus overlay without a second poll loop. When the response omits
        /// the <c>countdown</c> field (or sets it to <c>null</c>) we clear local state so a
        /// scrub is reflected immediately on the next telemetry tick.
        /// </summary>
        private static void ParseCountdown(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            // Shape: "countdown":{"startsAtMs":1714000000000,"lengthSec":10}
            var cKey = "\"countdown\"";
            var ci = json.IndexOf(cKey, StringComparison.Ordinal);
            if (ci < 0)
            {
                TowerCountdownState.Clear();
                return;
            }

            var colon = json.IndexOf(':', ci + cKey.Length);
            if (colon < 0)
            {
                return;
            }

            var afterColon = colon + 1;
            while (afterColon < json.Length && (json[afterColon] == ' ' || json[afterColon] == '\t'))
            {
                afterColon++;
            }

            // Server emits explicit `null` when no countdown is active — clear and bail.
            if (afterColon < json.Length && json[afterColon] == 'n')
            {
                TowerCountdownState.Clear();
                return;
            }

            if (afterColon >= json.Length || json[afterColon] != '{')
            {
                return;
            }

            // Find the matching closing brace for the countdown sub-object so we don't pick up
            // sibling number fields like nextTelemetrySeconds.
            int depth = 0;
            int objEnd = -1;
            for (int i = afterColon; i < json.Length; i++)
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
                        objEnd = i;
                        break;
                    }
                }
            }

            if (objEnd < 0)
            {
                return;
            }

            var countdownJson = json.Substring(afterColon, objEnd - afterColon + 1);

            long startsAtMs;
            int lengthSec;
            if (!TryReadLong(countdownJson, "\"startsAtMs\"", out startsAtMs) ||
                !TryReadInt(countdownJson, "\"lengthSec\"", out lengthSec))
            {
                return;
            }

            long serverNowMs;
            if (!TryReadLong(json, "\"serverNowMs\"", out serverNowMs))
            {
                // Fall back to local clock when the server forgot to include it; this introduces a
                // small drift but the HUD is still usable.
                serverNowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            }

            TowerCountdownState.Apply(startsAtMs, lengthSec, serverNowMs);
        }

        private static void ParseClearances(string json)
        {
            TowerClearanceState.ApplyFromTelemetryJson(json);
        }

        /// <summary>
        /// Reads <c>takeoffClearanceAtMs</c> + <c>serverNowMs</c> so the radio row can flash green
        /// for 10 s after tower grants takeoff (same clock basis as <see cref="ParseCountdown"/>).
        /// </summary>
        private static void ParseTakeoffClearance(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            var key = "\"takeoffClearanceAtMs\"";
            var ki = json.IndexOf(key, StringComparison.Ordinal);
            if (ki < 0)
            {
                return;
            }

            var colon = json.IndexOf(':', ki + key.Length);
            if (colon < 0)
            {
                return;
            }

            var p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            if (p < json.Length && json[p] == 'n')
            {
                TowerTakeoffClearanceState.Clear();
                return;
            }

            long grantedAtMs;
            if (!TryReadLong(json, "\"takeoffClearanceAtMs\"", out grantedAtMs))
            {
                return;
            }

            long serverNowMs;
            if (!TryReadLong(json, "\"serverNowMs\"", out serverNowMs))
            {
                serverNowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            }

            TowerTakeoffClearanceState.Apply(grantedAtMs, serverNowMs);
        }

        private static void ParseRadioState(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            string radioJson;
            if (!TryExtractObject(json, "\"radio\"", out radioJson))
            {
                TowerRadioState.Clear();
                return;
            }

            bool busy;
            bool blocked;
            if (!TryReadBool(radioJson, "\"busy\"", out busy))
            {
                busy = false;
            }
            if (!TryReadBool(radioJson, "\"blocked\"", out blocked))
            {
                blocked = false;
            }

            double freqMhz;
            var hasFreq = TryReadDouble(radioJson, "\"freqMhz\"", out freqMhz);

            long updatedAtMs;
            if (!TryReadLong(radioJson, "\"updatedAtMs\"", out updatedAtMs))
            {
                updatedAtMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            }

            long expiresAtMs;
            if (!TryReadLong(radioJson, "\"expiresAtMs\"", out expiresAtMs))
            {
                expiresAtMs = 0L;
            }

            long blockedAtMs;
            if (!TryReadLong(radioJson, "\"blockedAtMs\"", out blockedAtMs))
            {
                blockedAtMs = 0L;
            }

            var message = blocked ? "BLOCKED - SAY AGAIN" : (busy ? "FREQ BUSY" : string.Empty);
            TowerRadioState.Apply(busy, blocked, freqMhz, hasFreq, message, updatedAtMs, expiresAtMs, blockedAtMs);
        }

        private static bool TryExtractObject(string json, string quotedKey, out string objectJson)
        {
            objectJson = null;
            var keyIndex = json.IndexOf(quotedKey, StringComparison.Ordinal);
            if (keyIndex < 0)
            {
                return false;
            }

            var colon = json.IndexOf(':', keyIndex + quotedKey.Length);
            if (colon < 0)
            {
                return false;
            }

            var p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            if (p >= json.Length || json[p] != '{')
            {
                return false;
            }

            int depth = 0;
            for (int i = p; i < json.Length; i++)
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
                        objectJson = json.Substring(p, i - p + 1);
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool TryReadLong(string json, string quotedKey, out long value)
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

            var p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            var startNum = p;
            if (p < json.Length && json[p] == '-')
            {
                p++;
            }

            while (p < json.Length && char.IsDigit(json[p]))
            {
                p++;
            }

            if (p <= startNum)
            {
                return false;
            }

            return long.TryParse(
                json.Substring(startNum, p - startNum),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out value);
        }

        private static bool TryReadInt(string json, string quotedKey, out int value)
        {
            long l;
            if (TryReadLong(json, quotedKey, out l) && l >= int.MinValue && l <= int.MaxValue)
            {
                value = (int)l;
                return true;
            }

            value = 0;
            return false;
        }

        private static bool TryReadDouble(string json, string quotedKey, out double value)
        {
            value = 0.0;
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

            var p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            var startNum = p;
            if (p < json.Length && (json[p] == '-' || json[p] == '+'))
            {
                p++;
            }

            while (p < json.Length && (char.IsDigit(json[p]) || json[p] == '.'))
            {
                p++;
            }

            if (p <= startNum)
            {
                return false;
            }

            return double.TryParse(
                json.Substring(startNum, p - startNum),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out value);
        }

        private static bool TryReadBool(string json, string quotedKey, out bool value)
        {
            value = false;
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

            var p = colon + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t'))
            {
                p++;
            }

            if (p + 4 <= json.Length && string.Compare(json, p, "true", 0, 4, StringComparison.Ordinal) == 0)
            {
                value = true;
                return true;
            }

            if (p + 5 <= json.Length && string.Compare(json, p, "false", 0, 5, StringComparison.Ordinal) == 0)
            {
                value = false;
                return true;
            }

            return false;
        }

        private void ParseNextInterval(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            var key = "\"nextTelemetrySeconds\"";
            var i = json.IndexOf(key, System.StringComparison.Ordinal);
            if (i < 0)
            {
                return;
            }

            var colon = json.IndexOf(':', i + key.Length);
            if (colon < 0)
            {
                return;
            }

            var end = colon + 1;
            while (end < json.Length && (json[end] == ' ' || json[end] == '\t'))
            {
                end++;
            }

            var startNum = end;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '.'))
            {
                end++;
            }

            if (end <= startNum)
            {
                return;
            }

            var numStr = json.Substring(startNum, end - startNum);
            float sec;
            if (float.TryParse(numStr, NumberStyles.Float, CultureInfo.InvariantCulture, out sec) && sec > 0.5f && sec < 120f)
            {
                _nextIntervalSeconds = sec;
            }
        }

        private string BuildTelemetryJson(Vessel v)
        {
            var sb = new StringBuilder(2048);
            sb.Append("{");

            // --- Identity ---------------------------------------------------------
            AppendString(sb, "craftName", ResolveCraftDisplayName(v), true);
            AppendString(sb, "pilotName", TowerVesselCallsignStore.GetEffectivePilotCallsign(v), false);
            var sessionCs = (TowerModSettings.SessionCallsign ?? string.Empty).Trim();
            if (sessionCs.Length > 0)
            {
                AppendString(sb, "callsign", sessionCs, false);
            }

            AppendString(sb, "craftType", v.vesselType.ToString(), false);
            // Stable id survives in-flight renames; controller strips can correlate
            // the same airframe across tower handoffs even if the pilot edits the
            // vessel name mid-flight.
            AppendString(sb, "persistentId", v.persistentId.ToString(CultureInfo.InvariantCulture), false);
            AppendString(sb, "craftMapIcon", ComputeCraftMapIcon(v), false);
            // Player-chosen "stock craft" silhouette other clients render as our ghost. Empty
            // string = "let the receiver auto-detect from craftMapIcon"; the radio panel's MY
            // GHOST cycler writes a roster key (e.g. "aeris4a") here.
            AppendString(sb, "ghostCraftKey", TowerModSettings.GhostCraftKey ?? string.Empty, false);
            // Mirror of the local GHO switch. When false the backend strips this session out of
            // /v1/tower/active-aircraft so other pilots' ghost-fleet renderers don't see us
            // either. Telemetry-driven controller features (strip, scoring) are unaffected,
            // which is the whole point of having this be a separate switch from BCN.
            AppendBool(sb, "ghostOptOut", !TowerModSettings.EnableGhostFleet, false);

            // --- Time / world -----------------------------------------------------
            AppendNum(sb, "universalTime", Planetarium.GetUniversalTime(), false);
            AppendNum(sb, "metSeconds", v.missionTime, false);
            AppendString(sb, "bodyName", v.mainBody != null ? v.mainBody.bodyName : string.Empty, false);
            AppendString(sb, "situation", v.situation.ToString(), false);
            AppendString(sb, "biome", ResolveBiomeName(v), false);

            // --- Position / motion -----------------------------------------------
            AppendNum(sb, "lat", v.latitude, false);
            AppendNum(sb, "lon", v.longitude, false);
            AppendNum(sb, "radarAlt", v.radarAltitude, false);
            AppendNum(sb, "aslAlt", v.altitude, false);
            AppendNum(sb, "surfaceSpeed", v.srfSpeed, false);
            AppendNum(sb, "verticalSpeed", v.verticalSpeed, false);
            // Aviation speeds tower controllers actually use: IAS for clearances,
            // Mach for high-altitude/hypersonic ops. `indicatedAirSpeed` is m/s
            // density-corrected by stock; consumers convert to knots if they want.
            AppendNum(sb, "indicatedAirSpeed", SafeFinite(v.indicatedAirSpeed), false);
            AppendNum(sb, "mach", SafeFinite(v.mach), false);

            // --- Attitude ---------------------------------------------------------
            AppendNum(sb, "heading", SurfaceHeadingDegrees(v), false);
            // Ground track (velocity bearing) for ghost dead-reckon; `heading` is nose on the horizon.
            AppendNum(sb, "surfaceTrack", SurfaceTrackDegrees(v), false);
            double pitchDeg, rollDeg;
            ComputeAttitude(v, out pitchDeg, out rollDeg);
            AppendNum(sb, "pitch", pitchDeg, false);
            AppendNum(sb, "roll", rollDeg, false);
            AppendNum(sb, "aoa", AngleOfAttackDegrees(v), false);

            AppendAugmentedFlightFields(sb, v, SurfaceTrackDegrees(v));

            // --- Pilot inputs / trim ---------------------------------------------
            AppendNum(sb, "throttle", v.ctrlState.mainThrottle, false);
            sb.Append(',').Append("\"trim\":{");
            AppendNum(sb, "pitch", v.ctrlState.pitchTrim, true);
            AppendNum(sb, "roll", v.ctrlState.rollTrim, false);
            AppendNum(sb, "yaw", v.ctrlState.yawTrim, false);
            sb.Append('}');

            // --- Action groups (back-compat flat fields stay; full set added) ----
            AppendBool(sb, "gearDown", v.ActionGroups[KSPActionGroup.Gear], false);
            AppendBool(sb, "brakes", v.ActionGroups[KSPActionGroup.Brakes], false);
            AppendBool(sb, "lights", v.ActionGroups[KSPActionGroup.Light], false);
            AppendBool(sb, "rcs", v.ActionGroups[KSPActionGroup.RCS], false);
            AppendBool(sb, "sas", v.ActionGroups[KSPActionGroup.SAS], false);
            AppendBool(sb, "abort", v.ActionGroups[KSPActionGroup.Abort], false);
            AppendBool(sb, "stage", v.ActionGroups[KSPActionGroup.Stage], false);
            AppendBoolArray(sb, "customGroups", CollectCustomActionGroups(v), false);

            // --- SAS mode (stock autopilot mode the pilot is asking for) ---------
            if (v.Autopilot != null)
            {
                AppendString(sb, "sasMode", v.Autopilot.Mode.ToString(), false);
            }

            // --- Orbit ------------------------------------------------------------
            if (v.orbit != null && !v.LandedOrSplashed)
            {
                AppendNum(sb, "apoapsis", v.orbit.ApA, false);
                AppendNum(sb, "periapsis", v.orbit.PeA, false);
            }

            // --- G load (instantaneous + per-flight peak) ------------------------
            var g = v.geeForce;
            if (g > _maxGLoadThisFlight)
            {
                _maxGLoadThisFlight = g;
            }
            AppendNum(sb, "gLoad", g, false);
            AppendNum(sb, "gLoadMax", _maxGLoadThisFlight, false);

            // --- Mass / crew ------------------------------------------------------
            double wetMass, dryMass;
            ComputeMasses(v, out wetMass, out dryMass);
            AppendNum(sb, "wetMass", wetMass, false);
            AppendNum(sb, "dryMass", dryMass, false);

            int crewCurrent, crewCapacity;
            var crewNames = CollectCrew(v, out crewCurrent, out crewCapacity);
            AppendNum(sb, "crewCurrent", crewCurrent, false);
            AppendNum(sb, "crewCapacity", crewCapacity, false);
            AppendStringArray(sb, "crewNames", crewNames, false);
            // Per-kerbal stock stats (trait, level, courage, stupidity, veteran/badass)
            // — emitted regardless of Kerbalism so the Tower's crew expansion works
            // on a stock save. Kerbalism's per-crew dose lives in the kerbalism block.
            AppendCrewStatsArray(sb, "crewStats", v, false);

            // --- Single part-walk for everything that needs to scan modules ------
            // One pass keeps per-tick cost bounded for big craft (200+ parts).
            var scan = ScanParts(v);

            AppendNum(sb, "partsCount", scan.PartCount, false);
            AppendBool(sb, "overheating", scan.Overheating, false);
            AppendBool(sb, "fuelLow", ComputeFuelLow(scan), false);
            AppendBool(sb, "docked", scan.Docked, false);

            // Temperature block (see COCKPIT_INSTRUMENTS_PLAN.md §2). Five
            // always-present fields + an optional `hotPart` callout. KSP's
            // externalTemperature/atmosphericTemperature are Kelvin; convert to
            // Celsius on the wire so consumers don't have to know.
            sb.Append(',').Append("\"temperature\":{");
            AppendNum(sb, "engineMaxRatio", SafeFinite(scan.EngineMaxRatio), true);
            AppendNum(sb, "skinMaxRatio", SafeFinite(scan.SkinMaxRatio), false);
            AppendNum(sb, "internalMaxRatio", SafeFinite(scan.InternalMaxRatio), false);
            AppendNum(sb, "externalC", SafeFinite(v.externalTemperature - 273.15), false);
            AppendNum(sb, "atmosphericC", SafeFinite(v.atmosphericTemperature - 273.15), false);
            sb.Append(',').Append("\"hotPart\":");
            if (scan.HotPartRatio > 0.70 && !string.IsNullOrEmpty(scan.HotPartName))
            {
                sb.Append('{');
                AppendString(sb, "name", scan.HotPartName, true);
                AppendNum(sb, "ratio", SafeFinite(scan.HotPartRatio), false);
                AppendString(sb, "kind", scan.HotPartKind ?? "internal", false);
                sb.Append('}');
            }
            else
            {
                sb.Append("null");
            }
            sb.Append('}');

            // Engines block: count lit / flameouts / total thrust / TWR.
            sb.Append(',').Append("\"engines\":{");
            AppendNum(sb, "count", scan.EngineCount, true);
            AppendNum(sb, "lit", scan.EnginesLit, false);
            AppendNum(sb, "flameouts", scan.EngineFlameouts, false);
            AppendNum(sb, "totalThrustKn", scan.TotalThrustKn, false);
            // TWR derived locally — wet mass × local gravity. Skip when grav is 0
            // (deep space) or thrust is 0 to avoid div-by-zero / Inf on the wire.
            // FlightGlobals.getGeeForceAtPosition returns the gravity acceleration
            // vector (m/s²) at a world position; magnitude is the scalar g we want.
            var localG = v.mainBody != null
                ? FlightGlobals.getGeeForceAtPosition(v.GetWorldPos3D()).magnitude
                : 0d;
            var weightKn = wetMass * localG;
            var twr = (weightKn > 0.0001 && scan.TotalThrustKn > 0)
                ? scan.TotalThrustKn / weightKn
                : 0d;
            AppendNum(sb, "twr", twr, false);
            sb.Append('}');

            // Resources (only emit ones the vessel actually has).
            AppendResourcesObject(sb, "resources", scan.Resources, false);

            // Parachutes / bays / deployables (counts only — controller-side
            // surface decides whether to render a "PAX BAY OPEN" caution).
            AppendCountObject(sb, "parachutes", new[]
            {
                new KeyValuePair<string, int>("armed", scan.ChutesArmed),
                new KeyValuePair<string, int>("deployed", scan.ChutesDeployed),
                new KeyValuePair<string, int>("cut", scan.ChutesCut),
                new KeyValuePair<string, int>("total", scan.ChutesTotal)
            }, false);
            AppendCountObject(sb, "bays", new[]
            {
                new KeyValuePair<string, int>("open", scan.BaysOpen),
                new KeyValuePair<string, int>("total", scan.BaysTotal)
            }, false);
            AppendCountObject(sb, "solarPanels", new[]
            {
                new KeyValuePair<string, int>("deployed", scan.SolarDeployed),
                new KeyValuePair<string, int>("total", scan.SolarTotal)
            }, false);
            AppendCountObject(sb, "antennas", new[]
            {
                new KeyValuePair<string, int>("deployed", scan.AntennasDeployed),
                new KeyValuePair<string, int>("total", scan.AntennasTotal)
            }, false);
            AppendCountObject(sb, "radiators", new[]
            {
                new KeyValuePair<string, int>("deployed", scan.RadiatorsDeployed),
                new KeyValuePair<string, int>("total", scan.RadiatorsTotal)
            }, false);
            AppendCountObject(sb, "airbrakes", new[]
            {
                new KeyValuePair<string, int>("deployed", scan.AirbrakesDeployed),
                new KeyValuePair<string, int>("total", scan.AirbrakesTotal)
            }, false);

            // FAR (Ferram Aerospace Research) — flap setting + spoiler bool. Only
            // emit when FAR is installed; tower UI keys off `far.available` to
            // decide whether to show the flap indicator at all.
            int farFlap;
            bool farSpoiler;
            if (TryGetFarSurfaceState(v, out farFlap, out farSpoiler))
            {
                sb.Append(',').Append("\"far\":{");
                AppendBool(sb, "available", true, true);
                AppendNum(sb, "flap", farFlap, false);
                AppendBool(sb, "spoiler", farSpoiler, false);
                sb.Append('}');
            }

            // EVA — only meaningful when the active vessel IS the kerbal on EVA
            // (the lone EVA is its own vessel in stock KSP). Tower wants to know
            // both that the pilot is outside the ship and how much jetpack juice
            // is left for the swim back.
            if (v.isEVA)
            {
                AppendBool(sb, "isEva", true, false);
                AppendNum(sb, "evaPropellant", scan.EvaPropellantRatio, false);
            }
            else
            {
                AppendBool(sb, "isEva", false, false);
            }

            // Target (vessel target only — body target gives the controller no
            // useful operational signal). Distance/bearing/closure are computed
            // in the body-fixed frame so values match what the pilot's nav ball
            // shows.
            AppendTargetBlock(sb, v, false);

            // --- Subsystems block (which of this pilot's feeds are live) ---------
            // Lets the controller see at a glance "beacon ON, KOS feed OFF, hullcam
            // serving 2 cams, voice bridge alive". Each field is sourced from the
            // module that owns the subsystem so the truth lives in one place per
            // feed and the publisher just snapshots it.
            sb.Append(',').Append("\"subsystems\":{");
            // Beacon: this payload only goes out at all when the beacon is on
            // (the loop short-circuits to a `beacon_off` status edge otherwise),
            // so the value here is always true. Included for explicitness so the
            // tower UI doesn't have to special-case "no field == on".
            AppendBool(sb, "beacon", TowerModSettings.BeaconActive, true);
            AppendBool(sb, "kosStream", TowerModSettings.KosScreenStreamActive, false);
            sb.Append(',').Append("\"hullcam\":{");
            AppendBool(sb, "enabled", TowerModSettings.EnableHullCamRelay, true);
            AppendBool(sb, "available", TowerHullCamRelay.JrtiReachable, false);
            AppendNum(sb, "cameraCount", TowerHullCamRelay.LiveCameraCount, false);
            sb.Append('}');
            // Voice bridge: any TCP reply (even ERR) within the last 15 s counts
            // as alive — same window the radio panel's BRIDGE LED uses, so the
            // tower indicator agrees with what the pilot sees in-game.
            AppendBool(sb, "voiceBridge", TowerVoiceBridgeControl.RecentlyAlive(15.0), false);
            sb.Append('}');

            // --- Mods (radiation, Kerbalism life-support, CommNet) ---------------
            // Top-level radiation/radiationAvailable kept for one release of
            // back-compat with consumers that haven't migrated to the kerbalism
            // namespace yet (per KERBALISM_TELEMETRY_PLAN.md §2). The full
            // Kerbalism block (life support + per-crew dose + storm) goes
            // through AppendKerbalismBlock — the consumer prefers the namespaced
            // version when both are present.
            double rads;
            if (TryGetKerbalismRadiation(v, out rads))
            {
                AppendNum(sb, "radiation", rads, false);
                AppendBool(sb, "radiationAvailable", true, false);
            }
            else
            {
                AppendBool(sb, "radiationAvailable", false, false);
            }

            AppendKerbalismBlock(sb, v, false);

            AppendCommNetStatus(sb, v);

            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// Snapshot of all per-part state we collect in a single iteration over
        /// <see cref="Vessel.parts"/>. Bundling it avoids walking the part list
        /// once per category (engines, parachutes, deployables, ...) which would
        /// thrash CPU on big craft.
        /// </summary>
        private struct PartScan
        {
            public int PartCount;
            public bool Overheating;
            public bool Docked;

            public int EngineCount;
            public int EnginesLit;
            public int EngineFlameouts;
            public double TotalThrustKn;

            public int ChutesArmed;
            public int ChutesDeployed;
            public int ChutesCut;
            public int ChutesTotal;

            public int BaysOpen;
            public int BaysTotal;

            public int SolarDeployed;
            public int SolarTotal;
            public int AntennasDeployed;
            public int AntennasTotal;
            public int RadiatorsDeployed;
            public int RadiatorsTotal;

            public int AirbrakesDeployed;
            public int AirbrakesTotal;

            public Dictionary<string, ResourceTotal> Resources;
            public double EvaPropellantRatio;

            // Temperature aggregation (see COCKPIT_INSTRUMENTS_PLAN.md §2). Each
            // bucket is the max ratio across the whole airframe; HotPart tracks
            // the single highest-ratio part for the controller's "HOT: <name>"
            // callout. Kind is "engine" / "skin" / "internal" depending on which
            // ratio won.
            public double EngineMaxRatio;
            public double SkinMaxRatio;
            public double InternalMaxRatio;
            public double HotPartRatio;
            public string HotPartName;
            public string HotPartKind;
        }

        private struct ResourceTotal
        {
            public double Current;
            public double Max;
        }

        /// <summary>
        /// Walks <paramref name="v"/>.parts once and aggregates everything the
        /// payload needs from per-part modules and resources. Each module check is
        /// individually try/caught so a single faulty part module from a third-party
        /// mod can't blank out the rest of the scan.
        /// </summary>
        private static PartScan ScanParts(Vessel v)
        {
            var s = new PartScan
            {
                Resources = new Dictionary<string, ResourceTotal>(8)
            };

            if (v == null || v.parts == null)
            {
                return s;
            }

            s.PartCount = v.parts.Count;
            for (int i = 0; i < v.parts.Count; i++)
            {
                var p = v.parts[i];
                if (p == null)
                {
                    continue;
                }

                // --- Temperature ratios (see COCKPIT_INSTRUMENTS_PLAN.md §2) ---
                // Compute the two stock ratios up front; engine bucket is bumped
                // below if this part hosts a ModuleEngines.
                double internalRatio = (p.maxTemp > 0) ? (p.temperature / p.maxTemp) : 0d;
                double skinRatio = (p.skinMaxTemp > 0) ? (p.skinTemperature / p.skinMaxTemp) : 0d;

                if (internalRatio > s.InternalMaxRatio)
                {
                    s.InternalMaxRatio = internalRatio;
                }
                if (skinRatio > s.SkinMaxRatio)
                {
                    s.SkinMaxRatio = skinRatio;
                }

                // Legacy `overheating` bool — preserved one release for backend
                // back-compat, see COCKPIT_INSTRUMENTS_PLAN.md §2.5.
                if (internalRatio > 0.85 || skinRatio > 0.85)
                {
                    s.Overheating = true;
                }

                // Hot-part candidate: the higher of skin/internal for this part.
                // Engine kind is reassigned below if applicable.
                double partWorst = (skinRatio > internalRatio) ? skinRatio : internalRatio;
                string partKind = (skinRatio > internalRatio) ? "skin" : "internal";

                // Resources: sum current + max per resource name across parts.
                if (p.Resources != null)
                {
                    for (int r = 0; r < p.Resources.Count; r++)
                    {
                        var res = p.Resources[r];
                        if (res == null || string.IsNullOrEmpty(res.resourceName))
                        {
                            continue;
                        }

                        ResourceTotal acc;
                        s.Resources.TryGetValue(res.resourceName, out acc);
                        acc.Current += res.amount;
                        acc.Max += res.maxAmount;
                        s.Resources[res.resourceName] = acc;
                    }
                }

                bool isEnginePart = false;
                if (p.Modules != null)
                {
                    for (int m = 0; m < p.Modules.Count; m++)
                    {
                        var mod = p.Modules[m];
                        if (mod == null)
                        {
                            continue;
                        }

                        if (mod is ModuleEngines)
                        {
                            isEnginePart = true;
                        }

                        try
                        {
                            ScanModule(mod, ref s);
                        }
                        catch
                        {
                            // Defensive: a misbehaving third-party PartModule must not
                            // blank the entire telemetry sample. Stay quiet and move on.
                        }
                    }
                }

                // Engine bucket uses the part-level temp for engine-mounted parts
                // (stock ModuleEngines doesn't expose nozzle temp; the part is
                // the closest proxy and matches what the pilot's gauges read).
                if (isEnginePart && internalRatio > s.EngineMaxRatio)
                {
                    s.EngineMaxRatio = internalRatio;
                    if (internalRatio >= partWorst)
                    {
                        partWorst = internalRatio;
                        partKind = "engine";
                    }
                }

                if (partWorst > s.HotPartRatio)
                {
                    s.HotPartRatio = partWorst;
                    s.HotPartName = ResolvePartTitle(p);
                    s.HotPartKind = partKind;
                }
            }

            // EVA propellant ratio — only meaningful when v.isEVA. Look up the
            // EVA Propellant resource we already accumulated.
            if (v.isEVA)
            {
                ResourceTotal eva;
                if (s.Resources.TryGetValue("EVA Propellant", out eva) && eva.Max > 0)
                {
                    s.EvaPropellantRatio = eva.Current / eva.Max;
                }
            }

            return s;
        }

        private static void ScanModule(PartModule mod, ref PartScan s)
        {
            // Stock engines (ModuleEnginesFX inherits ModuleEngines so this catches both).
            var eng = mod as ModuleEngines;
            if (eng != null)
            {
                s.EngineCount++;
                if (eng.EngineIgnited && !eng.flameout)
                {
                    s.EnginesLit++;
                    s.TotalThrustKn += eng.finalThrust;
                }
                if (eng.flameout)
                {
                    s.EngineFlameouts++;
                }
                return;
            }

            var chute = mod as ModuleParachute;
            if (chute != null)
            {
                s.ChutesTotal++;
                switch (chute.deploymentState)
                {
                    case ModuleParachute.deploymentStates.ACTIVE:
                        s.ChutesArmed++;
                        break;
                    case ModuleParachute.deploymentStates.SEMIDEPLOYED:
                    case ModuleParachute.deploymentStates.DEPLOYED:
                        s.ChutesDeployed++;
                        break;
                    case ModuleParachute.deploymentStates.CUT:
                        s.ChutesCut++;
                        break;
                }
                return;
            }

            var dock = mod as ModuleDockingNode;
            if (dock != null)
            {
                // Stock states are e.g. "Ready", "Acquire", "Disengage", "Docked
                // (docker)", "Docked (dockee)", "PreAttached". Anything starting
                // with "Docked" or "PreAttached" means we're physically attached
                // to another craft right now.
                var st = dock.state ?? string.Empty;
                if (st.StartsWith("Docked", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(st, "PreAttached", StringComparison.OrdinalIgnoreCase))
                {
                    s.Docked = true;
                }
                return;
            }

            var bay = mod as ModuleCargoBay;
            if (bay != null)
            {
                s.BaysTotal++;
                if (!bay.ClosedAndLocked())
                {
                    s.BaysOpen++;
                }
                return;
            }

            // Stock airbrake. ModuleAeroSurface exposes `deploy` (bool) for "is
            // the airbrake currently extended". ModuleControlSurface (ailerons /
            // elevators / rudders) inherits from ModuleAeroSurface, so the type
            // test alone would over-count every flight surface as an airbrake —
            // explicitly exclude ModuleControlSurface to fence them off.
            var airbrake = mod as ModuleAeroSurface;
            if (airbrake != null && !(mod is ModuleControlSurface))
            {
                s.AirbrakesTotal++;
                if (airbrake.deploy)
                {
                    s.AirbrakesDeployed++;
                }
                return;
            }

            // Deployable solar/antenna/radiator share a base class. Order of
            // type-tests matters: check the most-specific first so we count each
            // panel exactly once into the right bucket.
            var solar = mod as ModuleDeployableSolarPanel;
            if (solar != null)
            {
                s.SolarTotal++;
                if (solar.deployState == ModuleDeployablePart.DeployState.EXTENDED)
                {
                    s.SolarDeployed++;
                }
                return;
            }

            var antenna = mod as ModuleDeployableAntenna;
            if (antenna != null)
            {
                s.AntennasTotal++;
                if (antenna.deployState == ModuleDeployablePart.DeployState.EXTENDED)
                {
                    s.AntennasDeployed++;
                }
                return;
            }

            var rad = mod as ModuleDeployableRadiator;
            if (rad != null)
            {
                s.RadiatorsTotal++;
                if (rad.deployState == ModuleDeployablePart.DeployState.EXTENDED)
                {
                    s.RadiatorsDeployed++;
                }
                return;
            }
        }

        /// <summary>
        /// Custom action group state (AG1 .. AG10) packed as an ordered bool[10].
        /// Stock <see cref="KSPActionGroup"/> only declares Custom01..Custom10 so
        /// we hard-code the ten enum values rather than reflecting; no scenario
        /// pulls in more anyway.
        /// </summary>
        private static bool[] CollectCustomActionGroups(Vessel v)
        {
            var arr = new bool[10];
            if (v == null || v.ActionGroups == null)
            {
                return arr;
            }

            arr[0] = v.ActionGroups[KSPActionGroup.Custom01];
            arr[1] = v.ActionGroups[KSPActionGroup.Custom02];
            arr[2] = v.ActionGroups[KSPActionGroup.Custom03];
            arr[3] = v.ActionGroups[KSPActionGroup.Custom04];
            arr[4] = v.ActionGroups[KSPActionGroup.Custom05];
            arr[5] = v.ActionGroups[KSPActionGroup.Custom06];
            arr[6] = v.ActionGroups[KSPActionGroup.Custom07];
            arr[7] = v.ActionGroups[KSPActionGroup.Custom08];
            arr[8] = v.ActionGroups[KSPActionGroup.Custom09];
            arr[9] = v.ActionGroups[KSPActionGroup.Custom10];
            return arr;
        }

        /// <summary>
        /// Pitch and roll (degrees) in the local horizon frame. Pitch is positive
        /// when nose-up; roll is positive on right wing down. Returns 0 / 0 when
        /// the reference transform isn't available yet (early flight ticks before
        /// command pod is fully online).
        /// </summary>
        private static void ComputeAttitude(Vessel v, out double pitchDeg, out double rollDeg)
        {
            pitchDeg = 0;
            rollDeg = 0;

            if (v == null || v.ReferenceTransform == null || v.mainBody == null)
            {
                return;
            }

            var up = v.upAxis;
            if (up.sqrMagnitude < 1e-6f)
            {
                return;
            }

            up.Normalize();
            var bodyNorth = v.mainBody.transform.forward;
            var east = Vector3.Cross(up, bodyNorth);
            if (east.sqrMagnitude < 1e-6f)
            {
                return;
            }
            east.Normalize();
            var north = Vector3.Cross(east, up);
            north.Normalize();

            // Stock convention: command-pod "forward" is the part's local up axis.
            var forward = v.ReferenceTransform.up;
            var right = v.ReferenceTransform.right;

            // Pitch: angle between forward and the local horizon plane. Sign is
            // positive when forward points above the horizon (i.e. dot with up>0).
            var horizForward = Vector3.ProjectOnPlane(forward, up);
            if (horizForward.sqrMagnitude > 1e-6f)
            {
                horizForward.Normalize();
                var pitch = Vector3.SignedAngle(horizForward, forward, Vector3.Cross(forward, horizForward));
                // SignedAngle's sign flips on the cross direction; recover with dot(forward, up).
                pitchDeg = Mathf.Sign(Vector3.Dot(forward, up)) * Mathf.Abs(pitch);
            }
            else
            {
                pitchDeg = Vector3.Dot(forward, up) > 0 ? 90 : -90;
            }

            // Roll: rotation of the right axis around the forward vector relative
            // to the local horizon plane. Right wing down = positive.
            var horizRight = Vector3.ProjectOnPlane(right, up);
            if (horizRight.sqrMagnitude > 1e-6f)
            {
                horizRight.Normalize();
                rollDeg = Vector3.SignedAngle(horizRight, right, forward);
            }
        }

        /// <summary>
        /// Reflection probe for FAR's per-control-surface flap and spoiler
        /// settings. We pick the *highest* flap setting on the vessel as the
        /// "flap setting" the controller cares about (matches what the pilot's
        /// own FAR HUD shows — there's one selector for the whole airframe).
        /// Returns false when FAR isn't installed so the caller can omit the
        /// `far` block entirely.
        /// </summary>
        private static bool _farProbed;
        private static Type _farSurfaceType;
        private static FieldInfo _farFlapSettingField;
        private static FieldInfo _farSpoilerSettingField;

        private static bool TryGetFarSurfaceState(Vessel v, out int flapSetting, out bool spoiler)
        {
            flapSetting = 0;
            spoiler = false;

            if (!_farProbed)
            {
                _farProbed = true;
                try
                {
                    var assemblies = AppDomain.CurrentDomain.GetAssemblies();
                    for (int i = 0; i < assemblies.Length; i++)
                    {
                        var asm = assemblies[i];
                        if (asm == null)
                        {
                            continue;
                        }

                        var name = asm.GetName().Name;
                        if (string.IsNullOrEmpty(name) ||
                            name.IndexOf("FerramAerospaceResearch", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            continue;
                        }

                        var t = asm.GetType("ferram4.FARControllableSurface", false);
                        if (t == null)
                        {
                            continue;
                        }

                        _farSurfaceType = t;
                        // FAR exposes both as KSPField on the PartModule. Names are
                        // stable across all FAR releases on KSP 1.12.
                        _farFlapSettingField = t.GetField("flapSetting",
                            BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
                        _farSpoilerSettingField = t.GetField("spoilerSetting",
                            BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
                        break;
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] FAR API probe failed: " + ex.Message);
                }
            }

            if (_farSurfaceType == null || v == null || v.parts == null)
            {
                return false;
            }

            bool any = false;
            int maxFlap = 0;
            bool anySpoiler = false;
            for (int i = 0; i < v.parts.Count; i++)
            {
                var p = v.parts[i];
                if (p == null || p.Modules == null)
                {
                    continue;
                }

                for (int m = 0; m < p.Modules.Count; m++)
                {
                    var mod = p.Modules[m];
                    if (mod == null || !_farSurfaceType.IsInstanceOfType(mod))
                    {
                        continue;
                    }

                    any = true;

                    if (_farFlapSettingField != null)
                    {
                        try
                        {
                            var raw = _farFlapSettingField.GetValue(mod);
                            if (raw is int)
                            {
                                var val = (int)raw;
                                if (val > maxFlap)
                                {
                                    maxFlap = val;
                                }
                            }
                        }
                        catch { /* ignore per-part read failures */ }
                    }

                    if (_farSpoilerSettingField != null && !anySpoiler)
                    {
                        try
                        {
                            var raw = _farSpoilerSettingField.GetValue(mod);
                            if (raw is bool && (bool)raw)
                            {
                                anySpoiler = true;
                            }
                        }
                        catch { /* ignore per-part read failures */ }
                    }
                }
            }

            if (!any)
            {
                return false;
            }

            flapSetting = maxFlap;
            spoiler = anySpoiler;
            return true;
        }

        private static readonly DateTime UnixEpochUtc = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // Kerbin aerodrome reference points — aligned with web `kerbinAeroCharts.ts` (KKSC / KAFD).
        private const double KkscRefLat = -0.05;
        private const double KkscRefLon = -74.6075;
        private const double KafdRefLat = -1.5175;
        private const double KafdRefLon = -71.911111;

        private void AppendAugmentedFlightFields(StringBuilder sb, Vessel v, double surfaceTrackDeg)
        {
            AppendNum(sb, "sampleUnixMs", (DateTime.UtcNow - UnixEpochUtc).TotalMilliseconds, false);

            UpdateSmoothedPosition(v);
            AppendBool(sb, "smoothedPositionValid", _hasSmoothedSample, false);
            if (_hasSmoothedSample)
            {
                AppendNum(sb, "smoothedLat", _smoothLat, false);
                AppendNum(sb, "smoothedLon", _smoothLon, false);
                AppendNum(sb, "smoothedAslAlt", _smoothAslAlt, false);
            }

            double vn, ve, vu;
            ComputeSrfVelEnu(v, out vn, out ve, out vu);
            AppendNum(sb, "srfVelNorth", vn, false);
            AppendNum(sb, "srfVelEast", ve, false);
            AppendNum(sb, "srfVelUp", vu, false);

            double distM;
            double bearingDeg;
            double alignErr;
            string activeRw;
            string aerodrome;
            bool onApproach;
            bool landing;
            string phase;
            double etaTd;

            ComputeKerbinFlightContext(
                v,
                surfaceTrackDeg,
                out distM,
                out bearingDeg,
                out alignErr,
                out activeRw,
                out aerodrome,
                out onApproach,
                out landing,
                out phase,
                out etaTd);

            _lastEmitDistKscM = distM;
            _lastEmitOnApproach = onApproach;
            _lastEmitLanding = landing;

            var onKerbin = v.mainBody != null &&
                           string.Equals(v.mainBody.bodyName, "Kerbin", StringComparison.Ordinal);
            if (onKerbin && distM > 5.0)
            {
                AppendNum(sb, "distKSC", distM, false);
                AppendNum(sb, "bearingKSC", bearingDeg, false);
                AppendNum(sb, "alignErr", alignErr, false);
                if (!string.IsNullOrEmpty(activeRw))
                {
                    AppendString(sb, "activeRunway", activeRw, false);
                }

                if (!string.IsNullOrEmpty(aerodrome))
                {
                    AppendString(sb, "kscAerodrome", aerodrome, false);
                }
            }

            AppendBool(sb, "onApproach", onApproach, false);
            AppendBool(sb, "landing", landing, false);
            AppendString(sb, "flightPhase", phase ?? "CRUISE", false);

            if (etaTd > 0.5 && etaTd < 6000.0 && !double.IsNaN(etaTd) && !double.IsInfinity(etaTd))
            {
                AppendNum(sb, "touchdownEtaSec", etaTd, false);
            }

            double radioMhz;
            if (TowerModSettings.TryResolveFrequencyForChannel(TowerModSettings.SessionId ?? string.Empty, out radioMhz) &&
                radioMhz > 1.0)
            {
                AppendNum(sb, "radioFreqMhz", radioMhz, false);
            }

            AppendBool(sb, "radioPtt", TowerPttBus.IsAnySourceOpen, false);
        }

        private void MaybeQueueFlightCallouts(Vessel v)
        {
            if (v == null || !TowerModSettings.BeaconActive)
            {
                return;
            }

            var sid = TowerModSettings.SessionId;
            if (string.IsNullOrEmpty(sid))
            {
                return;
            }

            if (!_lastEmitOnApproach)
            {
                _calloutRungMax = 0;
                return;
            }

            var ring = _lastEmitDistKscM < 10000.0 ? 3 : _lastEmitDistKscM < 20000.0 ? 2 : _lastEmitDistKscM < 30000.0 ? 1 : 0;
            if (ring <= _calloutRungMax)
            {
                return;
            }

            if (Time.unscaledTime < _nextCalloutAllowedUnscaled)
            {
                return;
            }

            string msg;
            if (ring >= 3)
            {
                msg = "[CALL] 10 km from KSC";
            }
            else if (ring >= 2)
            {
                msg = "[CALL] 20 km from KSC";
            }
            else
            {
                msg = "[CALL] 30 km from KSC";
            }

            _calloutRungMax = ring;
            _nextCalloutAllowedUnscaled = Time.unscaledTime + 4f;
            StartCoroutine(PostSessionChatLineCo(sid, msg));
        }

        private IEnumerator PostSessionChatLineCo(string sessionId, string text)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/messages";
            var json = "{\"text\":\"" + JsonEscape(text) + "\"}";
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                // Best-effort: never spam logs on failure (offline / CSRF / role).
            }
        }

        private void UpdateSmoothedPosition(Vessel v)
        {
            if (v == null || v.mainBody == null)
            {
                return;
            }

            var pid = unchecked((uint)v.persistentId);

            var lat = v.latitude;
            var lon = v.longitude;
            var asl = v.altitude;

            if (!_hasSmoothedSample || pid != _smoothPid)
            {
                _smoothPid = pid;
                _smoothLat = lat;
                _smoothLon = lon;
                _smoothAslAlt = asl;
                _hasSmoothedSample = true;
                return;
            }

            if (GreatCircleDistanceMeters(_smoothLat, _smoothLon, lat, lon, v.mainBody.Radius) > 800.0)
            {
                _smoothLat = lat;
                _smoothLon = lon;
                _smoothAslAlt = asl;
                return;
            }

            var a = (double)PositionSmoothAlpha;
            _smoothLat += (lat - _smoothLat) * a;
            _smoothLon += (lon - _smoothLon) * a;
            _smoothAslAlt += (asl - _smoothAslAlt) * a;
        }

        private static void ComputeSrfVelEnu(Vessel v, out double north, out double east, out double up)
        {
            north = east = up = 0;
            if (v == null)
            {
                return;
            }

            Vector3 n;
            Vector3 u;
            if (!TrySurfaceNorthUp(v, out n, out u))
            {
                return;
            }

            var e = Vector3.Cross(u, n);
            if (e.sqrMagnitude < 1e-8f)
            {
                return;
            }

            e.Normalize();
            var vel = v.srf_velocity;
            north = Vector3.Dot(vel, n);
            east = Vector3.Dot(vel, e);
            up = Vector3.Dot(vel, u);
        }

        private static bool ComputeFuelLow(PartScan scan)
        {
            if (scan.Resources == null || scan.Resources.Count == 0)
            {
                return false;
            }

            ResourceTotal lf;
            ResourceTotal ox;
            var hasLf = scan.Resources.TryGetValue("LiquidFuel", out lf);
            var hasOx = scan.Resources.TryGetValue("Oxidizer", out ox);
            if (!hasLf && !hasOx)
            {
                return false;
            }

            var max = (hasLf ? lf.Max : 0) + (hasOx ? ox.Max : 0);
            var cur = (hasLf ? lf.Current : 0) + (hasOx ? ox.Current : 0);
            if (max < 1e-3)
            {
                return false;
            }

            return cur / max < 0.10;
        }

        private static void ComputeKerbinFlightContext(
            Vessel v,
            double surfaceTrackDeg,
            out double distMeters,
            out double bearingToRefDeg,
            out double alignErrDeg,
            out string activeRunway,
            out string aerodromeId,
            out bool onApproach,
            out bool landing,
            out string flightPhase,
            out double touchdownEtaSec)
        {
            distMeters = 0;
            bearingToRefDeg = 0;
            alignErrDeg = 0;
            activeRunway = string.Empty;
            aerodromeId = string.Empty;
            onApproach = false;
            landing = false;
            touchdownEtaSec = 0;
            flightPhase = DeriveFlightPhase(v);

            if (v == null || v.mainBody == null ||
                !string.Equals(v.mainBody.bodyName, "Kerbin", StringComparison.Ordinal))
            {
                return;
            }

            var r = v.mainBody.Radius;
            var dKksc = GreatCircleDistanceMeters(v.latitude, v.longitude, KkscRefLat, KkscRefLon, r);
            var dKafd = GreatCircleDistanceMeters(v.latitude, v.longitude, KafdRefLat, KafdRefLon, r);
            var useIsland = dKafd + 500.0 < dKksc;
            var refLat = useIsland ? KafdRefLat : KkscRefLat;
            var refLon = useIsland ? KafdRefLon : KkscRefLon;
            aerodromeId = useIsland ? "KAFD" : "KKSC";
            distMeters = GreatCircleDistanceMeters(v.latitude, v.longitude, refLat, refLon, r);
            bearingToRefDeg = InitialBearingDeg(v.latitude, v.longitude, refLat, refLon);

            if (distMeters < 120000.0)
            {
                var h09 = useIsland ? 90.0 : 89.85;
                var h27 = useIsland ? 270.0 : 270.15;
                var d09 = AbsAngleDeg(surfaceTrackDeg - h09);
                var d27 = AbsAngleDeg(surfaceTrackDeg - h27);
                activeRunway = d09 <= d27 ? "09" : "27";
                var rwyH = activeRunway == "09" ? h09 : h27;
                alignErrDeg = AbsAngleDeg(surfaceTrackDeg - rwyH);
            }

            var radar = v.radarAltitude;
            var altUse = (radar > 0 && !double.IsNaN(radar) && !double.IsInfinity(radar)) ? radar : v.altitude;
            onApproach = alignErrDeg < 20.0 && distMeters < 30000.0 && altUse < 3000.0;
            landing = onApproach && v.verticalSpeed < 0.0;

            if (radar > 1.0 && v.verticalSpeed < -0.5)
            {
                touchdownEtaSec = radar / (-v.verticalSpeed);
            }

            if (onApproach)
            {
                flightPhase = landing ? "LANDING" : "APPROACH";
            }
        }

        private static string DeriveFlightPhase(Vessel v)
        {
            if (v == null)
            {
                return "CRUISE";
            }

            if (v.LandedOrSplashed)
            {
                return "TAXI";
            }

            var radar = v.radarAltitude;
            var hasRadar = radar > 0 && !double.IsNaN(radar) && !double.IsInfinity(radar);
            if (hasRadar && radar < 500.0 && v.verticalSpeed > 12.0)
            {
                return "TAKEOFF";
            }

            if (hasRadar && radar < 400.0 && v.srfSpeed < 25.0)
            {
                return "TAXI";
            }

            if (v.altitude > 12000.0 || (hasRadar && radar > 8000.0))
            {
                return "CRUISE";
            }

            if (v.verticalSpeed > 8.0 && hasRadar && radar < 2500.0)
            {
                return "CLIMB";
            }

            return "CRUISE";
        }

        private static double AbsAngleDeg(double a)
        {
            while (a > 180.0) a -= 360.0;
            while (a < -180.0) a += 360.0;
            return Math.Abs(a);
        }

        private static double GreatCircleDistanceMeters(double lat1Deg, double lon1Deg, double lat2Deg, double lon2Deg, double radius)
        {
            var lat1 = lat1Deg * Math.PI / 180.0;
            var lat2 = lat2Deg * Math.PI / 180.0;
            var dLat = lat2 - lat1;
            var dLon = (lon2Deg - lon1Deg) * Math.PI / 180.0;
            var h = Math.Sin(dLat / 2.0) * Math.Sin(dLat / 2.0) +
                    Math.Cos(lat1) * Math.Cos(lat2) * Math.Sin(dLon / 2.0) * Math.Sin(dLon / 2.0);
            var c = 2.0 * Math.Atan2(Math.Sqrt(h), Math.Sqrt(Math.Max(0.0, 1.0 - h)));
            return radius * c;
        }

        private static double InitialBearingDeg(double lat1Deg, double lon1Deg, double lat2Deg, double lon2Deg)
        {
            var lat1 = lat1Deg * Math.PI / 180.0;
            var lat2 = lat2Deg * Math.PI / 180.0;
            var dLon = (lon2Deg - lon1Deg) * Math.PI / 180.0;
            var y = Math.Sin(dLon) * Math.Cos(lat2);
            var x = Math.Cos(lat1) * Math.Sin(lat2) - Math.Sin(lat1) * Math.Cos(lat2) * Math.Cos(dLon);
            var br = Math.Atan2(y, x) * 180.0 / Math.PI;
            br = (br + 360.0) % 360.0;
            return br;
        }

        /// <summary>
        /// Emits <c>"target":{name,distanceM,bearingDeg,closureRateMs}</c> when the
        /// pilot has a vessel target set, or <c>"target":null</c> otherwise. We
        /// deliberately ignore body / waypoint targets — those don't drive ATC
        /// situational awareness.
        /// </summary>
        private static void AppendTargetBlock(StringBuilder sb, Vessel v, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }
            sb.Append("\"target\":");

            ITargetable tgt = null;
            try
            {
                tgt = FlightGlobals.fetch != null ? FlightGlobals.fetch.VesselTarget : null;
            }
            catch
            {
                tgt = null;
            }

            var tgtVessel = tgt as Vessel;
            if (tgtVessel == null || v == null)
            {
                sb.Append("null");
                return;
            }

            var rel = tgtVessel.GetWorldPos3D() - v.GetWorldPos3D();
            var distance = rel.magnitude;

            // Bearing: project the vessel→target vector onto the local horizon and
            // measure clockwise from north. Matches the nav-ball / map view convention.
            double bearing = 0;
            var up = v.upAxis;
            if (up.sqrMagnitude > 1e-6f && v.mainBody != null)
            {
                up.Normalize();
                var north = Vector3.ProjectOnPlane(v.mainBody.transform.forward, up);
                if (north.sqrMagnitude > 1e-6f)
                {
                    north.Normalize();
                    var horizRel = Vector3.ProjectOnPlane(rel, up);
                    if (horizRel.sqrMagnitude > 1e-6f)
                    {
                        horizRel.Normalize();
                        bearing = Vector3.SignedAngle(north, horizRel, up);
                        if (bearing < 0)
                        {
                            bearing += 360;
                        }
                    }
                }
            }

            // Closure rate: positive means we're approaching the target. Project
            // relative velocity onto the line-of-sight vector.
            double closure = 0;
            if (distance > 1e-3)
            {
                var relVel = v.obt_velocity - tgtVessel.obt_velocity;
                closure = Vector3d.Dot(relVel, rel.normalized);
            }

            sb.Append('{');
            // Reuse the same localizer-aware helper as `craftName` so default
            // "Untitled Space Craft" targets don't show up as "#autoLOC_501174".
            AppendString(sb, "name", ResolveCraftDisplayName(tgtVessel), true);
            AppendNum(sb, "distanceM", distance, false);
            AppendNum(sb, "bearingDeg", bearing, false);
            AppendNum(sb, "closureRateMs", closure, false);
            sb.Append('}');
        }

        /// <summary>
        /// Replace NaN/Infinity with 0 so JSON.stringify on the consumer side
        /// doesn't produce <c>null</c> in places we promised a number.
        /// </summary>
        private static double SafeFinite(double x)
        {
            return (double.IsNaN(x) || double.IsInfinity(x)) ? 0d : x;
        }

        /// <summary>
        /// Stock CommNet status from <see cref="Vessel.Connection"/>. When CommNet is disabled
        /// in difficulty settings <c>v.Connection</c> is <c>null</c>, in which case we publish
        /// <c>commNetAvailable=false</c> and skip the rest so the tower UI can render "DSN N/A"
        /// instead of a misleading "blackout". Treat <c>commsBlackout</c> as derived on the
        /// consumer side (<c>commNetAvailable &amp;&amp; !commLink</c>) — we don't push it as a
        /// field to keep the wire shape minimal.
        /// </summary>
        private static void AppendCommNetStatus(StringBuilder sb, Vessel v)
        {
            var conn = v != null ? v.Connection : null;
            if (conn == null)
            {
                AppendBool(sb, "commNetAvailable", false, false);
                return;
            }

            AppendBool(sb, "commNetAvailable", true, false);
            AppendBool(sb, "commLink", conn.IsConnected, false);
            AppendBool(sb, "commLinkHome", conn.IsConnectedHome, false);

            var sig = conn.SignalStrength;
            if (double.IsNaN(sig) || double.IsInfinity(sig))
            {
                sig = 0d;
            }

            AppendNum(sb, "commSignal", Math.Max(0d, Math.Min(1d, sig)), false);
        }

        /// <summary>Ship total mass (wet, t) and dry mass (t) by summing each part.</summary>
        private static void ComputeMasses(Vessel v, out double wetMass, out double dryMass)
        {
            double wet = 0d;
            double dry = 0d;
            if (v != null && v.parts != null)
            {
                for (int i = 0; i < v.parts.Count; i++)
                {
                    var p = v.parts[i];
                    if (p == null)
                    {
                        continue;
                    }

                    var pDry = (double)p.mass;
                    var pRes = (double)p.GetResourceMass();
                    dry += pDry;
                    wet += pDry + pRes;
                }
            }

            wetMass = wet;
            dryMass = dry;
        }

        /// <summary>Crew list across all parts. Returns names (kerbal full names) for occupied seats and counts for max capacity.</summary>
        private static List<string> CollectCrew(Vessel v, out int current, out int capacity)
        {
            var names = new List<string>(8);
            int cap = 0;
            if (v == null || v.parts == null)
            {
                current = 0;
                capacity = 0;
                return names;
            }

            for (int i = 0; i < v.parts.Count; i++)
            {
                var p = v.parts[i];
                if (p == null)
                {
                    continue;
                }

                cap += p.CrewCapacity;
                if (p.protoModuleCrew == null)
                {
                    continue;
                }

                for (int k = 0; k < p.protoModuleCrew.Count; k++)
                {
                    var c = p.protoModuleCrew[k];
                    if (c != null && !string.IsNullOrEmpty(c.name))
                    {
                        names.Add(c.name);
                    }
                }
            }

            current = names.Count;
            capacity = cap;
            return names;
        }

        /// <summary>
        /// Angle (deg) between vessel forward (transform.up in stock KSP convention) and surface velocity.
        /// Returns 0 when stationary or unavailable. Sign is always positive (magnitude of AoA).
        /// </summary>
        private static double AngleOfAttackDegrees(Vessel v)
        {
            if (v == null || v.rootPart == null || v.rootPart.transform == null)
            {
                return 0;
            }

            Vector3 vel = v.srf_velocity;
            if (vel.sqrMagnitude < 0.25f)
            {
                return 0;
            }

            // Stock convention: command pod "forward" is the part's local up axis.
            var forward = v.ReferenceTransform != null
                ? v.ReferenceTransform.up
                : v.rootPart.transform.up;
            if (forward.sqrMagnitude < 1e-6f)
            {
                return 0;
            }

            var dot = Mathf.Clamp(Vector3.Dot(forward.normalized, vel.normalized), -1f, 1f);
            return Mathf.Acos(dot) * Mathf.Rad2Deg;
        }

        // ---------------------------------------------------------------------
        // Reflection-cached Kerbalism API surface. Every entry is null when
        // Kerbalism isn't installed — and may individually be null when the
        // installed Kerbalism version doesn't expose that particular method
        // (the API has shifted across releases). Each per-frame consumer
        // checks its own MethodInfo for null, so a partial probe degrades
        // gracefully (e.g. radiation works but life-support doesn't, or vice
        // versa) instead of taking down the whole telemetry frame.
        //
        // Single one-shot probe via EnsureKerbalismProbe(); both the legacy
        // top-level radiation emit and the new Phase-4 kerbalism block share
        // the same cache.
        // ---------------------------------------------------------------------
        private static bool _kerbalismProbed;
        private static Type _kerbalismApiType;
        private static MethodInfo _kerbalismRadiationVesselMethod;       // double Radiation(Vessel)
        private static MethodInfo _kerbalismResourceAmountMethod;        // double ResourceAmount(Vessel, string)
        private static MethodInfo _kerbalismResourceCapacityMethod;      // double ResourceCapacity(Vessel, string)
        private static MethodInfo _kerbalismResourceRateMethod;          // double ResourceRate(Vessel, string)
        private static MethodInfo _kerbalismRadiationCrewMethod;         // double Radiation(ProtoCrewMember)
        private static MethodInfo _kerbalismStormIncomingMethod;         // bool   StormIncoming(CelestialBody)
        private static MethodInfo _kerbalismStormDurationMethod;         // double StormDuration(CelestialBody)

        private static void EnsureKerbalismProbe()
        {
            if (_kerbalismProbed)
            {
                return;
            }
            _kerbalismProbed = true;

            try
            {
                var assemblies = AppDomain.CurrentDomain.GetAssemblies();
                for (int i = 0; i < assemblies.Length; i++)
                {
                    var asm = assemblies[i];
                    if (asm == null)
                    {
                        continue;
                    }

                    var name = asm.GetName().Name;
                    if (string.IsNullOrEmpty(name) || name.IndexOf("Kerbalism", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    var apiType = asm.GetType("KERBALISM.API", false) ?? asm.GetType("Kerbalism.API", false);
                    if (apiType == null)
                    {
                        continue;
                    }

                    _kerbalismApiType = apiType;

                    _kerbalismRadiationVesselMethod = TryGetStaticMethod(apiType, "Radiation", typeof(Vessel));
                    _kerbalismResourceAmountMethod = TryGetStaticMethod(apiType, "ResourceAmount", typeof(Vessel), typeof(string));
                    _kerbalismResourceCapacityMethod = TryGetStaticMethod(apiType, "ResourceCapacity", typeof(Vessel), typeof(string));
                    _kerbalismResourceRateMethod = TryGetStaticMethod(apiType, "ResourceRate", typeof(Vessel), typeof(string));
                    _kerbalismRadiationCrewMethod = TryGetStaticMethod(apiType, "Radiation", typeof(ProtoCrewMember));
                    _kerbalismStormIncomingMethod = TryGetStaticMethod(apiType, "StormIncoming", typeof(CelestialBody));
                    _kerbalismStormDurationMethod = TryGetStaticMethod(apiType, "StormDuration", typeof(CelestialBody));
                    break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Kerbalism API probe failed: " + ex.Message);
            }
        }

        private static MethodInfo TryGetStaticMethod(Type t, string name, params Type[] argTypes)
        {
            try
            {
                return t.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, argTypes, null);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Returns Kerbalism rad/s for the active vessel via reflection; safe when Kerbalism is missing.</summary>
        private static bool TryGetKerbalismRadiation(Vessel v, out double rads)
        {
            rads = 0d;
            EnsureKerbalismProbe();
            if (_kerbalismRadiationVesselMethod == null || v == null)
            {
                return false;
            }

            try
            {
                var result = _kerbalismRadiationVesselMethod.Invoke(null, new object[] { v });
                if (result is double)
                {
                    var d = (double)result;
                    if (!double.IsNaN(d) && !double.IsInfinity(d))
                    {
                        rads = d;
                        return true;
                    }
                }
            }
            catch
            {
                // Stay quiet on per-frame failures so the telemetry loop keeps publishing other fields.
            }

            return false;
        }

        // ---------------------------------------------------------------------
        // Kerbalism life-support: amount + capacity + signed rate per resource.
        // KERBALISM.API.ResourceRate is signed — production positive, consumption
        // negative — so the consumer can derive a "seconds remaining" without us
        // having to second-guess the user's profile.
        // ---------------------------------------------------------------------

        /// <summary>
        /// Stock-resource-name list of Kerbalism life-support resources we probe
        /// every telemetry frame. Order is the JSON emission order. Resources
        /// the vessel doesn't carry (capacity = 0 and current = 0 and rate = 0)
        /// are skipped on emission so a stock-fuel-only craft doesn't bloat the
        /// payload with seven empty objects.
        /// </summary>
        private static readonly string[] KerbalismLifeSupportResources = new string[]
        {
            "Food", "Water", "Oxygen", "Nitrogen", "Atmosphere", "WasteAtmosphere", "CarbonDioxide"
        };

        private static string LifeSupportJsonKey(string stockName)
        {
            switch (stockName)
            {
                case "Food": return "food";
                case "Water": return "water";
                case "Oxygen": return "oxygen";
                case "Nitrogen": return "nitrogen";
                case "Atmosphere": return "atmosphere";
                case "WasteAtmosphere": return "wasteAtmosphere";
                case "CarbonDioxide": return "carbonDioxide";
                default: return stockName;
            }
        }

        private static bool TryReadKerbalismResource(
            Vessel v,
            string stockName,
            out double amount,
            out double capacity,
            out double ratePerSec)
        {
            amount = 0d;
            capacity = 0d;
            ratePerSec = 0d;
            if (v == null || string.IsNullOrEmpty(stockName)) return false;
            if (_kerbalismApiType == null) return false;

            bool any = false;
            var args = new object[] { v, stockName };

            if (_kerbalismResourceAmountMethod != null)
            {
                try
                {
                    var r = _kerbalismResourceAmountMethod.Invoke(null, args);
                    if (r is double) { amount = (double)r; any = true; }
                }
                catch { /* per-frame: stay quiet */ }
            }
            if (_kerbalismResourceCapacityMethod != null)
            {
                try
                {
                    var r = _kerbalismResourceCapacityMethod.Invoke(null, args);
                    if (r is double) { capacity = (double)r; any = true; }
                }
                catch { /* per-frame: stay quiet */ }
            }
            if (_kerbalismResourceRateMethod != null)
            {
                try
                {
                    var r = _kerbalismResourceRateMethod.Invoke(null, args);
                    if (r is double) { ratePerSec = (double)r; any = true; }
                }
                catch { /* per-frame: stay quiet */ }
            }

            return any;
        }

        /// <summary>
        /// Length of one home-body day in seconds, used to convert
        /// <c>secondsRemaining</c> to <c>daysRemaining</c> on the wire so the
        /// controller's "days left" reading matches what the player's KSP UI
        /// shows (Kerbin = 6 h, RSS Earth = 24 h, JNSQ Kerbin = 12 h, …).
        /// Falls back to 21600 s (Kerbin day) when <see cref="FlightGlobals"/>
        /// hasn't initialised the home body yet.
        /// </summary>
        private static double HomeBodyDaySeconds()
        {
            try
            {
                var home = FlightGlobals.GetHomeBody();
                if (home != null && home.rotationPeriod > 1.0
                    && !double.IsNaN(home.rotationPeriod) && !double.IsInfinity(home.rotationPeriod))
                {
                    return home.rotationPeriod;
                }
            }
            catch
            {
                // Fall through to Kerbin default.
            }
            return 21600d;
        }

        /// <summary>
        /// Top-level Kerbalism block on the telemetry frame. Always emits the
        /// <c>kerbalismAvailable</c> capability flag; when Kerbalism is
        /// installed, also emits a <c>kerbalism</c> object containing the
        /// sub-blocks the installed version actually exposes — life-support
        /// resource burn-down, per-crew radiation dose, and storm window.
        ///
        /// Wire shape:
        /// <code>
        /// "kerbalismAvailable": true,
        /// "kerbalism": {
        ///   "lifeSupport": {
        ///     "food":   { "amount":..., "max":..., "ratePerSec":..., "secondsRemaining":..., "daysRemaining":... },
        ///     "water":  ...,
        ///     "oxygen": ...
        ///   },
        ///   "crew": [ { "name":"Jeb", "doseRad":0.84 } ],
        ///   "storm": { "incoming":true, "durationSec":14400 }
        /// }
        /// </code>
        ///
        /// Brought forward from KERBALISM_TELEMETRY_PLAN.md Phase 4: the Tower
        /// Desk renders these fields directly so the controller can ask "how
        /// many days of food left?" without waiting on the deferred CapCom
        /// seat from MISSION_OPS_SEATS_PLAN.md.
        /// </summary>
        private static void AppendKerbalismBlock(StringBuilder sb, Vessel v, bool first)
        {
            EnsureKerbalismProbe();

            bool available = _kerbalismApiType != null;
            AppendBool(sb, "kerbalismAvailable", available, first);
            if (!available || v == null)
            {
                return;
            }

            sb.Append(',').Append("\"kerbalism\":{");
            bool kFirst = true;

            // --- Life support resources (food, water, O2, N2, atmosphere, …) ---
            if (_kerbalismResourceAmountMethod != null)
            {
                if (!kFirst) sb.Append(','); kFirst = false;
                sb.Append("\"lifeSupport\":{");
                bool resFirst = true;
                double dayLen = HomeBodyDaySeconds();

                for (int i = 0; i < KerbalismLifeSupportResources.Length; i++)
                {
                    var stockName = KerbalismLifeSupportResources[i];
                    double amount, capacity, rate;
                    if (!TryReadKerbalismResource(v, stockName, out amount, out capacity, out rate))
                    {
                        continue;
                    }
                    // Skip resources the vessel literally doesn't touch — saves payload
                    // and prevents "0 Nitrogen" rows on craft built before the player
                    // turned on the LS profile.
                    if (capacity <= 1e-9 && amount <= 1e-9 && Math.Abs(rate) <= 1e-9)
                    {
                        continue;
                    }

                    // secondsRemaining only meaningful when net-consuming. Rate sign
                    // convention follows Kerbalism: positive = production, negative =
                    // consumption.
                    double? secondsRemaining = null;
                    double? daysRemaining = null;
                    if (rate < -1e-9 && amount > 0d)
                    {
                        secondsRemaining = amount / -rate;
                        if (dayLen > 1.0)
                        {
                            daysRemaining = secondsRemaining.Value / dayLen;
                        }
                    }

                    if (!resFirst) sb.Append(',');
                    resFirst = false;

                    sb.Append('"').Append(LifeSupportJsonKey(stockName)).Append("\":{");
                    AppendNum(sb, "amount", SafeFinite(amount), true);
                    AppendNum(sb, "max", SafeFinite(capacity), false);
                    AppendNum(sb, "ratePerSec", SafeFinite(rate), false);
                    AppendNullableNum(sb, "secondsRemaining", secondsRemaining, false);
                    AppendNullableNum(sb, "daysRemaining", daysRemaining, false);
                    sb.Append('}');
                }
                sb.Append('}');
            }

            // --- Per-crew radiation dose (Kerbalism's accumulated rad) ---------
            if (_kerbalismRadiationCrewMethod != null && v.parts != null)
            {
                if (!kFirst) sb.Append(','); kFirst = false;
                sb.Append("\"crew\":[");
                bool cFirst = true;
                for (int i = 0; i < v.parts.Count; i++)
                {
                    var p = v.parts[i];
                    if (p == null || p.protoModuleCrew == null) continue;
                    for (int k = 0; k < p.protoModuleCrew.Count; k++)
                    {
                        var c = p.protoModuleCrew[k];
                        if (c == null) continue;

                        double dose = 0;
                        bool ok = false;
                        try
                        {
                            var r = _kerbalismRadiationCrewMethod.Invoke(null, new object[] { c });
                            if (r is double)
                            {
                                var d = (double)r;
                                if (!double.IsNaN(d) && !double.IsInfinity(d))
                                {
                                    dose = d;
                                    ok = true;
                                }
                            }
                        }
                        catch { /* per-frame: stay quiet */ }
                        if (!ok) continue;

                        if (!cFirst) sb.Append(',');
                        cFirst = false;
                        sb.Append('{');
                        AppendString(sb, "name", c.name ?? string.Empty, true);
                        AppendNum(sb, "doseRad", dose, false);
                        sb.Append('}');
                    }
                }
                sb.Append(']');
            }

            // --- Storm window (when StormIncoming is exposed by this Kerbalism build) ---
            if (_kerbalismStormIncomingMethod != null && v.mainBody != null)
            {
                bool incoming = false;
                try
                {
                    var inc = _kerbalismStormIncomingMethod.Invoke(null, new object[] { v.mainBody });
                    if (inc is bool) incoming = (bool)inc;
                }
                catch { /* per-frame: stay quiet */ }

                double durationSec = 0;
                bool durationKnown = false;
                if (_kerbalismStormDurationMethod != null)
                {
                    try
                    {
                        var dur = _kerbalismStormDurationMethod.Invoke(null, new object[] { v.mainBody });
                        if (dur is double)
                        {
                            var d = (double)dur;
                            if (!double.IsNaN(d) && !double.IsInfinity(d) && d >= 0)
                            {
                                durationSec = d;
                                durationKnown = true;
                            }
                        }
                    }
                    catch { /* per-frame: stay quiet */ }
                }

                if (!kFirst) sb.Append(','); kFirst = false;
                sb.Append("\"storm\":{");
                AppendBool(sb, "incoming", incoming, true);
                if (durationKnown)
                {
                    AppendNum(sb, "durationSec", SafeFinite(durationSec), false);
                }
                sb.Append('}');
            }

            sb.Append('}');
        }

        /// <summary>
        /// JSON-emit a number that may be unset, emitting <c>null</c> when absent
        /// or non-finite. Used for the Kerbalism life-support burn-down where
        /// <c>secondsRemaining</c> / <c>daysRemaining</c> are only meaningful
        /// when the resource is net-consumed.
        /// </summary>
        private static void AppendNullableNum(StringBuilder sb, string name, double? value, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }
            sb.Append('"').Append(name).Append("\":");
            if (value.HasValue && !double.IsNaN(value.Value) && !double.IsInfinity(value.Value))
            {
                sb.Append(value.Value.ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                sb.Append("null");
            }
        }

        /// <summary>
        /// Per-kerbal stock stats array, emitted on every telemetry frame
        /// regardless of whether Kerbalism is installed. Each entry carries the
        /// fields the Tower Desk surfaces on the crew expansion: trait,
        /// experience level, courage, stupidity, veteran/badass flags, plus
        /// cumulative G exposure when the property is available. Kerbalism's
        /// per-crew dose lives in the separate <c>kerbalism.crew[]</c> block —
        /// kept disjoint so a stock save still gets a usable crew table.
        /// </summary>
        private static void AppendCrewStatsArray(StringBuilder sb, string name, Vessel v, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }
            sb.Append('"').Append(name).Append("\":[");
            if (v != null && v.parts != null)
            {
                bool cFirst = true;
                for (int i = 0; i < v.parts.Count; i++)
                {
                    var p = v.parts[i];
                    if (p == null || p.protoModuleCrew == null) continue;
                    for (int k = 0; k < p.protoModuleCrew.Count; k++)
                    {
                        var c = p.protoModuleCrew[k];
                        if (c == null) continue;

                        if (!cFirst) sb.Append(',');
                        cFirst = false;
                        AppendCrewMember(sb, c);
                    }
                }
            }
            sb.Append(']');
        }

        private static void AppendCrewMember(StringBuilder sb, ProtoCrewMember c)
        {
            sb.Append('{');
            AppendString(sb, "name", c.name ?? string.Empty, true);

            // Trait: prefer the localized Title from ExperienceTrait (so
            // Localizer-aware planet packs get the player's chosen language)
            // and fall back to the bare TypeName / `c.trait` string when the
            // experience system isn't fully wired (early career / unowned).
            string trait = string.Empty;
            try
            {
                if (c.experienceTrait != null && !string.IsNullOrEmpty(c.experienceTrait.Title))
                {
                    trait = c.experienceTrait.Title;
                }
                else if (c.experienceTrait != null && !string.IsNullOrEmpty(c.experienceTrait.TypeName))
                {
                    trait = c.experienceTrait.TypeName;
                }
                else
                {
                    trait = c.trait ?? string.Empty;
                }
            }
            catch
            {
                trait = c.trait ?? string.Empty;
            }
            AppendString(sb, "trait", trait, false);

            string typeName;
            try { typeName = c.type.ToString(); }
            catch { typeName = "Crew"; }
            AppendString(sb, "type", typeName, false);

            AppendNum(sb, "experienceLevel", c.experienceLevel, false);
            AppendNum(sb, "experience", SafeFinite(c.experience), false);
            AppendNum(sb, "courage", SafeFinite(c.courage), false);
            AppendNum(sb, "stupidity", SafeFinite(c.stupidity), false);
            AppendBool(sb, "isVeteran", c.veteran, false);
            AppendBool(sb, "isBadass", c.isBadass, false);
            sb.Append('}');
        }

        /// <summary>
        /// Drives tower map marker: plane, landed wheel craft (rover), or rocket/default.
        /// Stock KSP has no Rover vessel type; rovers use landed + ModuleWheel after Plane is ruled out.
        /// </summary>
        private static string ComputeCraftMapIcon(Vessel v)
        {
            if (v.vesselType == VesselType.Plane)
            {
                return "plane";
            }

            if (v.vesselType != VesselType.Plane && v.LandedOrSplashed && VesselHasDriveWheel(v))
            {
                return "rover";
            }

            return "rocket";
        }

        private static bool VesselHasDriveWheel(Vessel v)
        {
            for (int i = 0; i < v.Parts.Count; i++)
            {
                Part p = v.Parts[i];
                if (p == null)
                {
                    continue;
                }

                if (p.Modules.Contains("ModuleWheel"))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Vessel display name as seen in the VAB / tracking station. <c>Vessel.vesselName</c> can
        /// hold a raw localization tag (e.g. "#autoLOC_501174" for default craft names like
        /// "Untitled Space Craft") so we run it through <c>KSP.Localization.Localizer.Format</c> to
        /// resolve to the user-facing string. Falls back to the raw value if formatting throws.
        /// </summary>
        private static string ResolveCraftDisplayName(Vessel v)
        {
            if (v == null)
            {
                return string.Empty;
            }

            var raw = v.vesselName ?? string.Empty;
            if (raw.Length == 0)
            {
                return string.Empty;
            }

            try
            {
                var resolved = KSP.Localization.Localizer.Format(raw);
                return string.IsNullOrEmpty(resolved) ? raw : resolved;
            }
            catch
            {
                return raw;
            }
        }

        /// <summary>
        /// User-facing part name ("AE-FF1 Airstream Protective Shell"), preferring
        /// <c>partInfo.title</c> (which is what the VAB tooltip shows) and falling
        /// back to the internal <c>name</c>. Used by the temperature hot-part
        /// callout so the controller sees the same name a player would recognise.
        /// </summary>
        private static string ResolvePartTitle(Part p)
        {
            if (p == null)
            {
                return string.Empty;
            }

            try
            {
                if (p.partInfo != null && !string.IsNullOrEmpty(p.partInfo.title))
                {
                    return p.partInfo.title;
                }
            }
            catch
            {
                // partInfo can be null on unusual mod parts; fall through.
            }

            return p.name ?? string.Empty;
        }

        /// <summary>
        /// KSP biome under the vessel (e.g. "Shores", "Highlands", "Midlands"). Uses the stock
        /// <see cref="ScienceUtil.GetExperimentBiome"/> helper, which already handles bodies with no
        /// biome map (returns empty) and works on planet-pack worlds. Wrapped in a try/catch because
        /// some early-flight ticks can fault the science API before <c>FlightGlobals</c> is fully
        /// settled.
        /// </summary>
        private static string ResolveBiomeName(Vessel v)
        {
            if (v == null || v.mainBody == null)
            {
                return string.Empty;
            }

            try
            {
                var biome = ScienceUtil.GetExperimentBiome(v.mainBody, v.latitude, v.longitude);
                return biome ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        /// <summary>
        /// True local "up" and great-circle north in the vessel surface frame. Used by both nose
        /// heading and ground track.
        /// </summary>
        /// <remarks>
        /// We first derive north from a tiny latitude step on the surface (same trick as
        /// <see cref="TowerGhostFleet"/> pose math). The older fallback cross
        /// <c>up × mainBody.transform.forward</c> can degenerate to ~0 when the body's Unity
        /// forward axis is nearly parallel to the local surface normal at the vessel, which
        /// would pin <c>heading</c> / <c>surfaceTrack</c> at 0° (map icon stuck north) even
        /// while moving east.
        /// </remarks>
        private static bool TrySurfaceNorthUp(Vessel v, out Vector3 north, out Vector3 up)
        {
            north = default(Vector3);
            up = v.upAxis;
            if (up.sqrMagnitude < 1e-6f)
            {
                return false;
            }

            up.Normalize();
            var body = v.mainBody;
            if (body != null)
            {
                try
                {
                    var p0 = body.GetWorldSurfacePosition(v.latitude, v.longitude, v.altitude);
                    var pN = body.GetWorldSurfacePosition(v.latitude + 0.0005, v.longitude, v.altitude);
                    north = Vector3.ProjectOnPlane(pN - p0, up);
                    if (north.sqrMagnitude > 1e-10f)
                    {
                        north.Normalize();
                        return true;
                    }
                }
                catch
                {
                    // GetWorldSurfacePosition can fault during scene / body churn.
                }
            }

            var bodyNorth = body != null ? body.transform.forward : Vector3.forward;
            var east = Vector3.Cross(up, bodyNorth);
            if (east.sqrMagnitude < 1e-6f)
            {
                return false;
            }

            east.Normalize();
            north = Vector3.Cross(east, up);
            north.Normalize();
            return true;
        }

        /// <summary>
        /// Ground track: horizontal surface velocity bearing, degrees clockwise from north.
        /// Used for lat/lon extrapolation between telemetry polls (ghost fleet).
        /// </summary>
        private static double SurfaceTrackDegrees(Vessel v)
        {
            Vector3 north;
            Vector3 up;
            if (!TrySurfaceNorthUp(v, out north, out up))
            {
                return 0;
            }

            var vel = Vector3.ProjectOnPlane(v.srf_velocity, up);
            if (vel.sqrMagnitude < 0.05f)
            {
                return 0;
            }

            vel.Normalize();
            return Vector3.SignedAngle(north, vel, up);
        }

        /// <summary>
        /// Compass-style heading of the vessel nose on the local horizon (command pod forward),
        /// degrees clockwise from north — matches the nav ball, not ground track in a slip.
        /// </summary>
        private static double SurfaceHeadingDegrees(Vessel v)
        {
            Vector3 north;
            Vector3 up;
            if (!TrySurfaceNorthUp(v, out north, out up))
            {
                return 0;
            }

            if (v.ReferenceTransform == null)
            {
                return SurfaceTrackDegrees(v);
            }

            var forward = v.ReferenceTransform.up;
            var horizForward = Vector3.ProjectOnPlane(forward, up);
            if (horizForward.sqrMagnitude < 1e-6f)
            {
                return SurfaceTrackDegrees(v);
            }

            horizForward.Normalize();
            return Vector3.SignedAngle(north, horizForward, up);
        }

        private static void AppendNum(StringBuilder sb, string name, double value, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":");
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
        }

        private static void AppendString(StringBuilder sb, string name, string value, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":\"").Append(JsonEscape(value)).Append('"');
        }

        private static void AppendBool(StringBuilder sb, string name, bool value, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":").Append(value ? "true" : "false");
        }

        private static void AppendStringArray(StringBuilder sb, string name, List<string> values, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":[");
            if (values != null)
            {
                for (int i = 0; i < values.Count; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }

                    sb.Append('"').Append(JsonEscape(values[i])).Append('"');
                }
            }

            sb.Append(']');
        }

        private static void AppendBoolArray(StringBuilder sb, string name, bool[] values, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":[");
            if (values != null)
            {
                for (int i = 0; i < values.Length; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }
                    sb.Append(values[i] ? "true" : "false");
                }
            }

            sb.Append(']');
        }

        /// <summary>
        /// Emits a flat object of integer counts, e.g.
        /// <c>"parachutes":{"armed":0,"deployed":2,"cut":0,"total":2}</c>. Keeps
        /// related fields grouped so the consumer can pick them up as a single
        /// `parachutes` object instead of fishing for sibling top-level keys.
        /// </summary>
        private static void AppendCountObject(StringBuilder sb, string name, KeyValuePair<string, int>[] entries, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":{");
            if (entries != null)
            {
                for (int i = 0; i < entries.Length; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }

                    sb.Append('"').Append(entries[i].Key).Append("\":")
                      .Append(entries[i].Value.ToString(CultureInfo.InvariantCulture));
                }
            }

            sb.Append('}');
        }

        /// <summary>
        /// Emits the resources block as
        /// <c>"resources":{"liquidFuel":{"current":...,"max":...},...}</c>. We
        /// only include resources the vessel actually carries (max &gt; 0), and
        /// remap the stock resource names to camelCase keys for nicer JSON. Any
        /// resource not in the rename table is passed through verbatim — modded
        /// resources still show up, just under their original name.
        /// </summary>
        private static void AppendResourcesObject(StringBuilder sb, string name, Dictionary<string, ResourceTotal> resources, bool first)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('"').Append(name).Append("\":{");
            if (resources != null)
            {
                bool isFirst = true;
                foreach (var kv in resources)
                {
                    if (kv.Value.Max <= 0)
                    {
                        continue;
                    }

                    if (!isFirst)
                    {
                        sb.Append(',');
                    }
                    isFirst = false;

                    var key = MapResourceKey(kv.Key);
                    sb.Append('"').Append(JsonEscape(key)).Append("\":{");
                    AppendNum(sb, "current", kv.Value.Current, true);
                    AppendNum(sb, "max", kv.Value.Max, false);
                    sb.Append('}');
                }
            }

            sb.Append('}');
        }

        /// <summary>
        /// Stock resource names → camelCase JSON keys. Unknown resources fall
        /// through unchanged so mods are still represented (just under their raw
        /// stock-style name like "Karbonite" rather than "karbonite").
        /// </summary>
        private static string MapResourceKey(string stockName)
        {
            switch (stockName)
            {
                case "LiquidFuel": return "liquidFuel";
                case "Oxidizer": return "oxidizer";
                case "MonoPropellant": return "monoPropellant";
                case "ElectricCharge": return "electricCharge";
                case "IntakeAir": return "intakeAir";
                case "SolidFuel": return "solidFuel";
                case "XenonGas": return "xenonGas";
                case "Ablator": return "ablator";
                case "Ore": return "ore";
                case "EVA Propellant": return "evaPropellant";
                default: return stockName;
            }
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
        }
    }
}
