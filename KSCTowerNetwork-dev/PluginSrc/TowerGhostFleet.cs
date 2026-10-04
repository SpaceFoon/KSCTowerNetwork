using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Canonical roster of "stock craft" silhouettes a player can pick to represent themselves
    /// in other pilots' tower views. Each entry has a stable key (sent over the wire), a
    /// human-readable label (shown in the radio panel cycler), and a silhouette family used by
    /// <see cref="TowerGhostFleetBase.BuildSilhouette"/> to assemble the proxy.
    ///
    /// Keys are deliberately short and stable — once a key ships in a release, the wire shape
    /// is locked. Renaming a label is fine; renaming a key would orphan saved <c>ghostCraftKey</c>
    /// values in player auth.cfgs.
    ///
    /// "auto" is the empty / null sentinel: the receiving side falls back to the auto-derived
    /// <c>craftMapIcon</c> (plane / rover / rocket) so a player who has never opened the picker
    /// still appears as something sensible.
    /// </summary>
    public static class TowerGhostRoster
    {
        public sealed class Entry
        {
            public string Key;
            public string Label;
            /// <summary>Silhouette family used by BuildSilhouette switch. Cheaper than per-entry mesh data.</summary>
            public string Silhouette;
            public Entry(string key, string label, string silhouette)
            {
                Key = key; Label = label; Silhouette = silhouette;
            }
        }

        /// <summary>Player choices, ordered for the cycler (small -> big plane, then rocket).</summary>
        public static readonly Entry[] All = new[]
        {
            new Entry("auto",       "AUTO  (vessel type)",  "auto"),
            new Entry("aeris3a",    "AERIS  3A",            "small_plane"),
            new Entry("aeris4a",    "AERIS  4A",            "delta_jet"),
            new Entry("learstar",   "LEARSTAR  A4",         "biz_jet"),
            new Entry("stearwing",  "STEARWING  A300",      "airliner"),
            new Entry("ravenspear", "RAVENSPEAR  MK4",      "fighter"),
            new Entry("dynawing",   "DYNAWING",             "shuttle"),
            new Entry("kerbalx",    "KERBAL  X",            "tall_rocket"),
            new Entry("acapello",   "ACAPELLO",             "lander_rocket")
        };

        /// <summary>
        /// Trim, lowercase, and look up against the roster. Unknown / empty values normalize to
        /// the empty string (= auto-detect) so a stale key from a future release doesn't break
        /// rendering on an older client.
        /// </summary>
        public static string Normalize(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            var trimmed = raw.Trim().ToLowerInvariant();
            if (trimmed.Length == 0 || trimmed == "auto") return string.Empty;
            for (int i = 0; i < All.Length; i++)
            {
                if (string.Equals(All[i].Key, trimmed, StringComparison.Ordinal))
                {
                    return All[i].Key;
                }
            }
            return string.Empty;
        }

        /// <summary>Resolve a stored key to the silhouette family used by BuildSilhouette.</summary>
        public static string SilhouetteFor(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            for (int i = 0; i < All.Length; i++)
            {
                if (string.Equals(All[i].Key, key, StringComparison.Ordinal))
                {
                    return All[i].Silhouette;
                }
            }
            return null;
        }

        /// <summary>Index of <paramref name="key"/> in <see cref="All"/>; 0 (= auto) for unknown.</summary>
        public static int IndexOf(string key)
        {
            if (string.IsNullOrEmpty(key)) return 0;
            for (int i = 0; i < All.Length; i++)
            {
                if (string.Equals(All[i].Key, key, StringComparison.Ordinal))
                {
                    return i;
                }
            }
            return 0;
        }

        /// <summary>Cycle to the next entry, wrapping. Used by the radio panel selector button.</summary>
        public static Entry Next(string currentKey)
        {
            var idx = IndexOf(currentKey);
            return All[(idx + 1) % All.Length];
        }
    }

    /// <summary>
    /// Spawns render-only proxy aircraft inside the local KSP world for every other live pilot
    /// reported by <c>GET /v1/tower/active-aircraft</c>. This is the "see other players from the
    /// tower" presence layer — the original "fake multiplayer" feature.
    ///
    /// Design notes:
    /// <list type="bullet">
    /// <item>Proxies are <see cref="PrimitiveType.Cube"/> meshes assembled into a generic
    /// plane/rover/rocket silhouette. Silhouette primitives stay render-only (colliders stripped).
    /// A separate trigger sphere on the root supports Dragon Radar: when <see cref="TowerDragonRadarGui"/>
    /// is open with an active hunt, another pilot's ghost can register a weapon hit from the
    /// active vessel and POST <c>dragon-radar/combat</c> "hit" before the proxy is hidden briefly.</item>
    /// <item>Position uses <see cref="CelestialBody.GetWorldSurfacePosition"/> so the proxy moves
    /// with the planet's frame (KSP's floating-origin / Krakensbane handles this naturally
    /// because the proxy is parented to nothing and re-positioned every poll cycle from scratch
    /// — we don't try to track between polls). At 2 s cadence this looks like ~2 fps which is
    /// fine for "watching from the tower".</item>
    /// <item>Only spawns when the player is at Kerbin and within ~50 km of the active vessel /
    /// camera. Skips work entirely outside Kerbin or while in tower-stream mode (the streamer
    /// doesn't need to see itself in its own broadcast).</item>
    /// </list>
    ///
    /// Two KSPAddon registrations — one for the Space Centre scene (so the player sees ghosts at
    /// KSC / from the tower window) and one for Flight (so a pilot taking off sees other pilots
    /// in the pattern). They run independently; KSP destroys + re-instantiates per scene change.
    /// </summary>
    public abstract class TowerGhostFleetBase : MonoBehaviour
    {
        private const float MinPollSeconds = 1f;
        private const float MaxPollSeconds = 10f;
        /// <summary>
        /// Beyond this distance from the player's camera the ghost is too small to matter and
        /// would just consume a draw call. The ATC tower is ~3 km from the runway threshold;
        /// 50 km gives generous coverage for the whole KSC / Island Airfield airspace without
        /// rendering ghosts that are over the horizon.
        /// </summary>
        private const float MaxRenderDistanceMeters = 50000f;
        /// <summary>
        /// Quiet back-off when /tower/active-aircraft is unreachable (backend offline, no auth)
        /// so we don't hammer the endpoint while the player flies offline.
        /// </summary>
        private const float UnreachableBackoffSeconds = 15f;

        /// <summary>
        /// Hard cap on how far we'll dead-reckon a stale sample (seconds). Beyond this we hold
        /// the last predicted pose: at airliner speeds extrapolating 5+ s is already unreliable
        /// because the pilot has almost certainly turned, and a frozen ghost reads as "lost
        /// signal" much better than a ghost that drifts kilometres off-course.
        /// </summary>
        private const double MaxExtrapolationSeconds = 5.0;

        /// <summary>
        /// On every new sample we capture the currently-rendered pose and ease toward the new
        /// dead-reckoned pose over this many seconds. Prevents the visible "snap" when the
        /// pilot's actual track diverged from our extrapolation between polls. Tuned short
        /// enough that the visible motion stays crisp at typical 1–2 s poll cadences.
        /// </summary>
        private const float CorrectionBlendSeconds = 0.25f;

        private readonly Dictionary<string, GhostProxy> _ghosts = new Dictionary<string, GhostProxy>();
        /// <summary>
        /// After a local weapon trigger removes a ghost, hold respawn briefly so the impact reads as a kill.
        /// </summary>
        private readonly Dictionary<string, float> _ghostCombatSuppressedUntil = new Dictionary<string, float>(StringComparer.Ordinal);
        private bool _started;
        private bool _backendUnreachable;
        private float _lastErrorLogTime;

        private sealed class GhostProxy
        {
            public string SessionId;
            public GameObject Root;
            public TextMesh Label;
            public string CraftIcon = "plane";

            /// <summary>Most-recent ground-truth sample from /tower/active-aircraft.</summary>
            public ActiveAircraftEntry LatestSample;
            /// <summary>Local <see cref="Time.unscaledTime"/> when <see cref="LatestSample"/> was applied; the dead-reckon clock zero.</summary>
            public float SampleAtUnscaledTime;

            /// <summary>True while we're easing from a captured pre-sample pose toward the freshly extrapolated pose.</summary>
            public bool HasBlendStart;
            /// <summary>Pose captured at the moment the latest sample arrived; the start of the correction blend.</summary>
            public Vector3 BlendStartPos;
            public Quaternion BlendStartRot;
            public float BlendStartUnscaledTime;
        }

        protected virtual void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(PollLoop());
        }

        protected virtual void OnDestroy()
        {
            ClearAllGhosts();
        }

        private IEnumerator PollLoop()
        {
            // Initial settle so the scene's CelestialBodies / cameras exist before we try to
            // place anything in world space.
            yield return new WaitForSeconds(2f);

            while (true)
            {
                var nominal = Mathf.Clamp(
                    TowerModSettings.GhostFleetPollSeconds,
                    MinPollSeconds,
                    MaxPollSeconds);

                if (!ShouldRun())
                {
                    if (_ghosts.Count > 0)
                    {
                        ClearAllGhosts();
                    }
                    yield return new WaitForSeconds(nominal);
                    continue;
                }

                yield return StartCoroutine(FetchAndApply());

                var wait = _backendUnreachable ? UnreachableBackoffSeconds : nominal;
                yield return new WaitForSeconds(wait);
            }
        }

        /// <summary>
        /// Master gate: ghost fleet only renders when the player is logged in, the toggle is on,
        /// they're at Kerbin (because the active-aircraft feed currently only carries Kerbin
        /// pilots — ghosts on Duna would just be rendered at wrong-body lat/lon), and they're
        /// not themselves streaming as the tower (tower-stream mode is "look from the window",
        /// not "fly while watching"; the web UI shows the JPEG view-streams there instead).
        /// </summary>
        private bool ShouldRun()
        {
            if (!TowerModSettings.EnableGhostFleet)
            {
                return false;
            }

            if (TowerModSettings.SkipTowerLogin)
            {
                // Dev open-auth — fine, backend will still respond. Don't gate on a token.
            }
            else if (string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                return false;
            }

            if (TowerModSettings.StreamAsTower)
            {
                return false;
            }

            var home = HomeBody();
            if (home == null)
            {
                return false;
            }

            return true;
        }

        private CelestialBody HomeBody()
        {
            try
            {
                return Planetarium.fetch != null ? Planetarium.fetch.Home : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private IEnumerator FetchAndApply()
        {
            if (TowerModSettings.UseUdpLiveTransport)
            {
                string udpReply;
                string udpError;
                if (TowerUdpClient.TryRequest(
                        TowerUdpMessageType.GhostQuery,
                        TowerModSettings.SessionId,
                        "{}",
                        out udpReply,
                        out udpError))
                {
                    _backendUnreachable = false;
                    TryApplySnapshotJson(udpReply);
                    yield break;
                }

                if (!TowerModSettings.LiveUdpFallbackHttp)
                {
                    _backendUnreachable = true;
                    if (!string.IsNullOrEmpty(udpError) && Time.unscaledTime - _lastErrorLogTime > 30f)
                    {
                        _lastErrorLogTime = Time.unscaledTime;
                        Debug.LogWarning("[KSCTowerNetwork] ghost-fleet UDP failed: " + udpError);
                    }
                    yield break;
                }
            }

            var url = TowerModSettings.ApiBaseUrl + "/tower/active-aircraft";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 6;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    _backendUnreachable = true;
                    yield break;
                }

                if (req.isHttpError)
                {
                    _backendUnreachable = true;
                    if (Time.unscaledTime - _lastErrorLogTime > 30f)
                    {
                        _lastErrorLogTime = Time.unscaledTime;
                        Debug.Log("[KSCTowerNetwork] ghost-fleet poll http " + req.responseCode);
                    }
                    yield break;
                }

                _backendUnreachable = false;

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(text))
                {
                    yield break;
                }

                TryApplySnapshotJson(text);
            }
        }

        private void TryApplySnapshotJson(string text)
        {
            ActiveAircraftResponse parsed = null;
            try
            {
                parsed = JsonUtility.FromJson<ActiveAircraftResponse>(text);
            }
            catch (Exception ex)
            {
                if (Time.unscaledTime - _lastErrorLogTime > 30f)
                {
                    _lastErrorLogTime = Time.unscaledTime;
                    Debug.LogWarning("[KSCTowerNetwork] ghost-fleet parse failed: " + ex.Message);
                }
                return;
            }

            if (parsed == null || parsed.aircraft == null)
            {
                ClearAllGhosts();
                return;
            }

            ApplyGhosts(parsed);
        }

        private void ApplyGhosts(ActiveAircraftResponse data)
        {
            var home = HomeBody();
            if (home == null)
            {
                return;
            }

            PurgeGhostCombatSuppressions();

            var maxCount = Mathf.Clamp(TowerModSettings.GhostFleetMaxCount, 0, 64);
            var keep = new HashSet<string>(StringComparer.Ordinal);

            // Sort by distance to player so the cap (when reached) prefers nearby aircraft.
            var camPos = GetReferenceWorldPos();

            var sorted = new List<ActiveAircraftEntry>(data.aircraft);
            sorted.Sort((a, b) =>
            {
                var pa = home.GetWorldSurfacePosition(EffectiveLat(a), EffectiveLon(a), EffectiveAslAlt(a));
                var pb = home.GetWorldSurfacePosition(EffectiveLat(b), EffectiveLon(b), EffectiveAslAlt(b));
                var da = (pa - camPos).sqrMagnitude;
                var db = (pb - camPos).sqrMagnitude;
                return da.CompareTo(db);
            });

            int spawned = 0;
            foreach (var a in sorted)
            {
                if (spawned >= maxCount) break;
                if (a == null || string.IsNullOrEmpty(a.sessionId)) continue;

                float supUntil;
                if (_ghostCombatSuppressedUntil.TryGetValue(a.sessionId, out supUntil) && Time.unscaledTime < supUntil)
                {
                    continue;
                }

                var worldPos = home.GetWorldSurfacePosition(EffectiveLat(a), EffectiveLon(a), EffectiveAslAlt(a));
                var distSq = (worldPos - camPos).sqrMagnitude;
                if (distSq > MaxRenderDistanceMeters * MaxRenderDistanceMeters)
                {
                    continue;
                }

                keep.Add(a.sessionId);

                GhostProxy g;
                bool isFresh = false;
                if (!_ghosts.TryGetValue(a.sessionId, out g) || g.Root == null)
                {
                    g = CreateProxy(a);
                    _ghosts[a.sessionId] = g;
                    isFresh = true;
                }
                else if (!string.Equals(g.CraftIcon, ResolveSilhouetteKey(a), StringComparison.Ordinal))
                {
                    // Pilot either switched vessels (plane -> rocket) or picked a different
                    // ghost craft from the radio panel; either way the silhouette family
                    // changed, so blow away the old proxy and rebuild it.
                    UnityEngine.Object.Destroy(g.Root);
                    g = CreateProxy(a);
                    _ghosts[a.sessionId] = g;
                    isFresh = true;
                }

                // Capture the currently-rendered pose so the upcoming Update() can ease from
                // it toward the freshly-applied sample's predicted pose. Skipped for brand
                // new ghosts (no prior pose to blend from — they pop into existence at the
                // sample's lat/lon, which is expected).
                if (!isFresh && g.LatestSample != null && g.Root != null)
                {
                    g.BlendStartPos = g.Root.transform.position;
                    g.BlendStartRot = g.Root.transform.rotation;
                    g.BlendStartUnscaledTime = Time.unscaledTime;
                    g.HasBlendStart = true;
                }

                g.LatestSample = a;
                g.SampleAtUnscaledTime = Time.unscaledTime;

                // Initial pose for fresh ghosts so they don't render at world origin for the
                // frame between ApplyGhosts and the first Update() tick.
                if (isFresh)
                {
                    PosePredicted(g, home, 0.0);
                }

                if (g.Label != null)
                {
                    g.Label.text = BuildLabel(a);
                }

                spawned++;
            }

            // Sweep ghosts that disappeared from the latest snapshot.
            if (_ghosts.Count > 0)
            {
                List<string> toDrop = null;
                foreach (var key in _ghosts.Keys)
                {
                    if (!keep.Contains(key))
                    {
                        (toDrop ?? (toDrop = new List<string>())).Add(key);
                    }
                }
                if (toDrop != null)
                {
                    for (int i = 0; i < toDrop.Count; i++)
                    {
                        DropGhost(toDrop[i]);
                    }
                }
            }
        }

        private Vector3 GetReferenceWorldPos()
        {
            try
            {
                if (FlightGlobals.ActiveVessel != null)
                {
                    return FlightGlobals.ActiveVessel.transform.position;
                }
            }
            catch (Exception)
            {
                /* Active vessel may not exist in the Space Centre scene — fall through. */
            }

            try
            {
                if (Camera.main != null)
                {
                    return Camera.main.transform.position;
                }
            }
            catch (Exception)
            {
                /* ignore */
            }

            return Vector3.zero;
        }

        private static double EffectiveLat(ActiveAircraftEntry a)
        {
            if (a != null && a.smoothedPositionValid)
            {
                return a.smoothedLat;
            }

            return a != null ? a.lat : 0d;
        }

        private static double EffectiveLon(ActiveAircraftEntry a)
        {
            if (a != null && a.smoothedPositionValid)
            {
                return a.smoothedLon;
            }

            return a != null ? a.lon : 0d;
        }

        private static double EffectiveAslAlt(ActiveAircraftEntry a)
        {
            if (a != null && a.smoothedPositionValid)
            {
                return a.smoothedAslAlt;
            }

            return a != null ? a.aslAlt : 0d;
        }

        private GhostProxy CreateProxy(ActiveAircraftEntry a)
        {
            var root = new GameObject("KSCTowerGhost-" + a.sessionId);
            // Don't tie ghosts to scene cleanup hacks; KSP loads/unloads our addon already.
            root.transform.SetParent(null, worldPositionStays: true);

            var silhouetteKey = ResolveSilhouetteKey(a);
            BuildSilhouette(root, silhouetteKey);
            AddGhostCombatHitbox(this, root, a.sessionId);

            var labelGo = new GameObject("Label");
            labelGo.transform.SetParent(root.transform, worldPositionStays: false);
            labelGo.transform.localPosition = new Vector3(0f, 6f, 0f);
            var label = labelGo.AddComponent<TextMesh>();
            label.fontSize = 32;
            label.characterSize = 0.25f;
            label.anchor = TextAnchor.MiddleCenter;
            label.alignment = TextAlignment.Center;
            label.color = new Color(0.85f, 0.95f, 1f, 1f);
            label.text = BuildLabel(a);

            // Make label always face the player (billboard) via a tiny helper added below.
            labelGo.AddComponent<Billboard>();

            return new GhostProxy
            {
                SessionId = a.sessionId,
                Root = root,
                Label = label,
                CraftIcon = silhouetteKey
            };
        }

        /// <summary>
        /// Resolve the silhouette family for an entry: prefer the player's chosen
        /// <see cref="ActiveAircraftEntry.ghostCraftKey"/> when set (mapped via
        /// <see cref="TowerGhostRoster"/>), otherwise fall back to the auto-derived
        /// <see cref="ActiveAircraftEntry.craftMapIcon"/> ("plane"/"rover"/"rocket"). Used as the
        /// rebuild trigger key in <see cref="ApplyGhosts"/>, so this MUST be deterministic
        /// for a given entry — never inject randomness here.
        /// </summary>
        private static string ResolveSilhouetteKey(ActiveAircraftEntry a)
        {
            if (a == null) return "plane";
            var fromRoster = TowerGhostRoster.SilhouetteFor(a.ghostCraftKey);
            if (!string.IsNullOrEmpty(fromRoster)) return fromRoster;
            return string.IsNullOrEmpty(a.craftMapIcon) ? "plane" : a.craftMapIcon;
        }

        /// <summary>
        /// Construct a generic, recognizable silhouette out of stripped-down Unity primitives.
        /// We strip colliders so the proxy can never collide with the player's vessel — Phase 1
        /// promise is "you can see them, you can't interact". Materials use the built-in
        /// <c>Standard</c> shader because KSP's renderer keeps it loaded for stock parts.
        /// </summary>
        private static void BuildSilhouette(GameObject root, string craftIcon)
        {
            var icon = (craftIcon ?? "plane").ToLowerInvariant();
            switch (icon)
            {
                case "rover":
                    AddPart(root, PrimitiveType.Cube, new Vector3(2.2f, 0.6f, 3.6f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.5f, 0.2f, 0.5f), new Vector3(-1.2f, -0.3f, 1.4f), WheelColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.5f, 0.2f, 0.5f), new Vector3(1.2f, -0.3f, 1.4f), WheelColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.5f, 0.2f, 0.5f), new Vector3(-1.2f, -0.3f, -1.4f), WheelColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.5f, 0.2f, 0.5f), new Vector3(1.2f, -0.3f, -1.4f), WheelColor());
                    break;

                // ---- Rocket family (auto-detected + roster) -----------------
                case "rocket":
                case "tall_rocket":
                    // Kerbal X — slim tall stack with a capsule top and base fins.
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(1.2f, 6f, 1.2f), new Vector3(0f, 6f, 0f), BodyColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.6f, 1.2f, 0.6f), new Vector3(0f, 13.5f, 0f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(2.4f, 0.2f, 0.6f), new Vector3(0f, 0.5f, 0f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.6f, 0.2f, 2.4f), new Vector3(0f, 0.5f, 0f), AccentColor());
                    break;

                case "lander_rocket":
                    // Acapello — short squat stack with broad lander legs to read as a moon-bus.
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(1.6f, 3f, 1.6f), new Vector3(0f, 3f, 0f), BodyColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(1.0f, 1.0f, 1.0f), new Vector3(0f, 7f, 0f), AccentColor());
                    // Splayed lander legs.
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.15f, 1.8f, 0.15f), new Vector3(-1.2f, 0.5f, 1.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.15f, 1.8f, 0.15f), new Vector3(1.2f, 0.5f, 1.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.15f, 1.8f, 0.15f), new Vector3(-1.2f, 0.5f, -1.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.15f, 1.8f, 0.15f), new Vector3(1.2f, 0.5f, -1.2f), AccentColor());
                    break;

                // ---- Plane family ------------------------------------------
                case "small_plane":
                    // Aeris 3A — short stubby fuselage, straight high-aspect wings, single tail.
                    AddPart(root, PrimitiveType.Cube, new Vector3(1.0f, 1.0f, 5f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(8f, 0.18f, 1.0f), new Vector3(0f, 0.4f, 0.5f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(2.4f, 0.18f, 0.7f), new Vector3(0f, 0.5f, -2.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.18f, 1.0f, 0.7f), new Vector3(0f, 0.7f, -2.2f), AccentColor());
                    break;

                case "delta_jet":
                    // Aeris 4A — sleek delta wing, swept-back, single fin.
                    AddPart(root, PrimitiveType.Cube, new Vector3(1.0f, 1.0f, 7f), Vector3.zero, BodyColor());
                    // Delta wing — longer chord at root, tapers outward.
                    AddPart(root, PrimitiveType.Cube, new Vector3(7f, 0.18f, 3.5f), new Vector3(0f, -0.1f, -1.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.2f, 1.4f, 1.6f), new Vector3(0f, 0.9f, -3.0f), AccentColor());
                    break;

                case "biz_jet":
                    // Learstar A4 — slim fuselage, swept wings mid-mounted, T-tail.
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.9f, 1.0f, 8f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(8f, 0.16f, 1.4f), new Vector3(0f, 0f, -0.4f), AccentColor());
                    // T-tail: vertical fin + horizontal stab atop it.
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.18f, 1.6f, 1.0f), new Vector3(0f, 0.9f, -3.6f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(2.4f, 0.16f, 0.8f), new Vector3(0f, 1.7f, -3.6f), AccentColor());
                    // Engines on aft fuselage (twin-pod look).
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.4f, 0.5f, 0.4f), new Vector3(-0.8f, 0.4f, -2.6f), AccentColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.4f, 0.5f, 0.4f), new Vector3(0.8f, 0.4f, -2.6f), AccentColor());
                    break;

                case "airliner":
                    // Stearwing A300 — long fuselage, big wing, two engine pods, tall tail.
                    AddPart(root, PrimitiveType.Cube, new Vector3(1.4f, 1.4f, 12f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(13f, 0.22f, 2.2f), new Vector3(0f, -0.2f, 0.4f), AccentColor());
                    // Two engine pods slung under the wings.
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.7f, 0.7f, 0.7f), new Vector3(-2.6f, -0.7f, 0.6f), AccentColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.7f, 0.7f, 0.7f), new Vector3(2.6f, -0.7f, 0.6f), AccentColor());
                    // Tail.
                    AddPart(root, PrimitiveType.Cube, new Vector3(3.4f, 0.22f, 1.2f), new Vector3(0f, 0.6f, -5.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.22f, 2.2f, 1.4f), new Vector3(0f, 1.6f, -5.2f), AccentColor());
                    break;

                case "fighter":
                    // Ravenspear Mk4 — short narrow body, sharp delta, twin tail fins.
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.8f, 0.8f, 6f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(5.5f, 0.16f, 2.6f), new Vector3(0f, 0f, -0.6f), AccentColor());
                    // Twin canted fins.
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.18f, 1.2f, 0.8f), new Vector3(-0.8f, 0.7f, -2.4f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.18f, 1.2f, 0.8f), new Vector3(0.8f, 0.7f, -2.4f), AccentColor());
                    break;

                case "shuttle":
                    // Dynawing — chunky orbiter body, large delta wings, single fin, OMS pods.
                    AddPart(root, PrimitiveType.Cube, new Vector3(2.0f, 1.6f, 9f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(11f, 0.22f, 4.5f), new Vector3(0f, -0.2f, -1.0f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.24f, 2.0f, 1.6f), new Vector3(0f, 1.4f, -3.8f), AccentColor());
                    // Tri-engine cluster on aft.
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.6f, 0.5f, 0.6f), new Vector3(-0.7f, 0.0f, -4.4f), AccentColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.6f, 0.5f, 0.6f), new Vector3(0.7f, 0.0f, -4.4f), AccentColor());
                    AddPart(root, PrimitiveType.Cylinder, new Vector3(0.6f, 0.5f, 0.6f), new Vector3(0f, 0.7f, -4.4f), AccentColor());
                    break;

                case "plane":
                default:
                    // Generic plane — used when no roster pick is set and the auto-detected map
                    // icon was "plane". Keep the original silhouette so legacy installs render
                    // exactly as before.
                    AddPart(root, PrimitiveType.Cube, new Vector3(1.4f, 1.2f, 6f), Vector3.zero, BodyColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(9f, 0.2f, 1.4f), new Vector3(0f, 0f, 0.2f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(3f, 0.2f, 0.9f), new Vector3(0f, 0.6f, -2.7f), AccentColor());
                    AddPart(root, PrimitiveType.Cube, new Vector3(0.2f, 1.2f, 0.9f), new Vector3(0f, 0.9f, -2.7f), AccentColor());
                    break;
            }
        }

        private static void AddPart(GameObject root, PrimitiveType prim, Vector3 scale, Vector3 localPos, Color color)
        {
            var go = GameObject.CreatePrimitive(prim);
            go.name = prim.ToString();
            // Render-only — no physics, no collisions, ever.
            var col = go.GetComponent<Collider>();
            if (col != null)
            {
                UnityEngine.Object.Destroy(col);
            }
            go.transform.SetParent(root.transform, worldPositionStays: false);
            go.transform.localPosition = localPos;
            go.transform.localScale = scale;

            var mr = go.GetComponent<MeshRenderer>();
            if (mr != null)
            {
                // KSP keeps the Standard shader loaded for parts; using it here means we
                // pick up KSP's lighting / fog automatically.
                var shader = Shader.Find("Standard") ?? Shader.Find("Diffuse");
                if (shader != null)
                {
                    mr.material = new Material(shader)
                    {
                        color = color
                    };
                }
                else
                {
                    mr.material.color = color;
                }
                mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                mr.receiveShadows = false;
            }
        }

        private static Color BodyColor()
        {
            return new Color(0.78f, 0.82f, 0.88f, 1f);
        }

        private static Color AccentColor()
        {
            return new Color(0.55f, 0.6f, 0.7f, 1f);
        }

        private static Color WheelColor()
        {
            return new Color(0.15f, 0.15f, 0.18f, 1f);
        }

        private static string BuildLabel(ActiveAircraftEntry a)
        {
            var cs = string.IsNullOrEmpty(a.callsign) ? null : a.callsign.Trim();
            var pilotRaw = string.IsNullOrEmpty(a.pilotName) ? "Pilot" : a.pilotName;
            var pilot = !string.IsNullOrEmpty(cs) ? cs : pilotRaw;
            var craft = string.IsNullOrEmpty(a.craftName) ? string.Empty : (" (" + a.craftName + ")");
            // Speed in m/s -> knots, rounded; matches what the tower web UI shows.
            var kts = (int)Math.Round(a.surfaceSpeed * 1.94384d);
            var alt = (int)Math.Round(a.aslAlt);
            return pilot + craft + "\n" + kts.ToString(CultureInfo.InvariantCulture) + " kts  " + alt.ToString(CultureInfo.InvariantCulture) + " m";
        }

        /// <summary>
        /// Per-frame pose pump for every live ghost. Runs the dead-reckoning extrapolation
        /// and the post-sample correction blend so motion is visually smooth even though new
        /// samples only arrive every ~2 s. Skipped entirely when there are no ghosts (the
        /// common idle case in Space Centre with no live pilots).
        /// </summary>
        protected virtual void Update()
        {
            if (_ghosts.Count == 0)
            {
                return;
            }

            var home = HomeBody();
            if (home == null)
            {
                return;
            }

            var nowT = Time.unscaledTime;
            foreach (var g in _ghosts.Values)
            {
                if (g == null || g.Root == null || g.LatestSample == null)
                {
                    continue;
                }

                double dt = nowT - g.SampleAtUnscaledTime;
                if (dt < 0) dt = 0;
                if (dt > MaxExtrapolationSeconds) dt = MaxExtrapolationSeconds;

                PosePredicted(g, home, dt);
            }
        }

        /// <summary>
        /// Compute the predicted world pose <paramref name="dt"/> seconds after the last
        /// sample by stepping lat/lon/alt forward at the sample's reported surface velocity,
        /// then write it onto the ghost. When a recent sample triggered a correction blend
        /// (<see cref="GhostProxy.HasBlendStart"/>), eases from the captured pre-sample pose
        /// toward the predicted pose over <see cref="CorrectionBlendSeconds"/>.
        ///
        /// We dead-reckon attitude as constant (the API doesn't expose roll/pitch/heading
        /// rates, and at typical 2 s poll cadences the average attitude error is small —
        /// turning aircraft will visibly correct on each new sample, which is what the
        /// blend is for).
        /// </summary>
        private static void PosePredicted(GhostProxy g, CelestialBody home, double dt)
        {
            var sample = g.LatestSample;
            if (sample == null || g.Root == null)
            {
                return;
            }

            var lat0 = EffectiveLat(sample);
            var lon0 = EffectiveLon(sample);
            var asl0 = EffectiveAslAlt(sample);

            // Convert ground-relative speed (m/s) into degrees-of-lat/lon per second.
            // Lat: planet radius is constant; Lon: radius shrinks with cos(lat). Clamp the
            // cosine away from zero so a high-latitude pilot (well outside KSC anyway) can't
            // make us divide by ~0 and shoot the ghost to infinity.
            double radius = home.Radius;
            double metersPerDegLat = radius * Math.PI / 180.0;
            double cosLat = Math.Cos(lat0 * Math.PI / 180.0);
            double metersPerDegLon = metersPerDegLat * Math.Max(0.05, Math.Abs(cosLat));

            // Position extrapolation follows ground track; nose attitude uses `heading`.
            double trackRad = sample.surfaceTrack * Math.PI / 180.0;
            double northVel = sample.surfaceSpeed * Math.Cos(trackRad);
            double eastVel = sample.surfaceSpeed * Math.Sin(trackRad);

            double predLat = lat0 + (northVel * dt) / metersPerDegLat;
            double predLon = lon0 + (eastVel * dt) / metersPerDegLon;
            double predAlt = asl0 + sample.verticalSpeed * dt;

            var worldPos = home.GetWorldSurfacePosition(predLat, predLon, predAlt);

            // KSP convention for vessel "up" at a surface point.
            var up = home.GetSurfaceNVector(predLat, predLon).normalized;
            // Build a "north" reference (great-circle north) by sampling a slightly higher latitude.
            var north = (home.GetWorldSurfacePosition(predLat + 0.001, predLon, predAlt) - worldPos).normalized;
            // Heading is degrees clockwise from north when looking down-up.
            var headingRot = Quaternion.AngleAxis((float)sample.heading, up);
            var fwd = headingRot * north;
            // Apply pitch (nose up positive) and roll (right wing down positive).
            var right = Vector3.Cross(up, fwd).normalized;
            var pitchRot = Quaternion.AngleAxis(-(float)sample.pitch, right);
            fwd = pitchRot * fwd;
            var rollRot = Quaternion.AngleAxis((float)sample.roll, fwd);
            up = rollRot * up;
            var predRot = Quaternion.LookRotation(fwd, up);

            // Blend from the captured pre-sample pose to the freshly-predicted pose using a
            // cubic ease-out: start fast (so the visible "I just got new data" snap is mostly
            // hidden in the first ~50 ms) and decelerate as we converge.
            if (g.HasBlendStart)
            {
                float blendT = (Time.unscaledTime - g.BlendStartUnscaledTime) / CorrectionBlendSeconds;
                if (blendT >= 1f)
                {
                    g.HasBlendStart = false;
                    g.Root.transform.position = worldPos;
                    g.Root.transform.rotation = predRot;
                }
                else
                {
                    float eased = 1f - Mathf.Pow(1f - blendT, 3f);
                    g.Root.transform.position = Vector3.Lerp(g.BlendStartPos, worldPos, eased);
                    g.Root.transform.rotation = Quaternion.Slerp(g.BlendStartRot, predRot, eased);
                }
            }
            else
            {
                g.Root.transform.position = worldPos;
                g.Root.transform.rotation = predRot;
            }
        }

        private void PurgeGhostCombatSuppressions()
        {
            if (_ghostCombatSuppressedUntil.Count == 0)
            {
                return;
            }
            var now = Time.unscaledTime;
            var dead = new List<string>();
            foreach (var kv in _ghostCombatSuppressedUntil)
            {
                if (now >= kv.Value)
                {
                    dead.Add(kv.Key);
                }
            }
            for (var i = 0; i < dead.Count; i++)
            {
                _ghostCombatSuppressedUntil.Remove(dead[i]);
            }
        }

        /// <summary>
        /// Called when the local active vessel intersects another pilot's ghost combat sphere while
        /// Dragon Radar is open — POSTs a "hit" then hides the proxy briefly.
        /// </summary>
        public void ReportGhostProximityHit(string victimSessionId)
        {
            if (string.IsNullOrEmpty(victimSessionId))
            {
                return;
            }
            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (own.Length > 0 && string.Equals(victimSessionId, own, StringComparison.Ordinal))
            {
                return;
            }
            if (!TowerDragonRadarGui.TryPostGhostFleetCombatHit(victimSessionId))
            {
                return;
            }
            DropGhost(victimSessionId);
            _ghostCombatSuppressedUntil[victimSessionId] = Time.unscaledTime + 10f;
        }

        private static void AddGhostCombatHitbox(TowerGhostFleetBase fleet, GameObject root, string sessionId)
        {
            if (fleet == null || root == null || string.IsNullOrEmpty(sessionId))
            {
                return;
            }
            var hit = new GameObject("KSCTowerGhostCombatHitbox");
            hit.transform.SetParent(root.transform, false);
            hit.transform.localPosition = Vector3.zero;
            var sphere = hit.AddComponent<SphereCollider>();
            sphere.isTrigger = true;
            sphere.radius = 16f;
            var trig = hit.AddComponent<TowerGhostCombatTrigger>();
            trig.Init(fleet, sessionId);
        }

        private void DropGhost(string sessionId)
        {
            GhostProxy g;
            if (!_ghosts.TryGetValue(sessionId, out g))
            {
                return;
            }

            _ghosts.Remove(sessionId);
            if (g != null && g.Root != null)
            {
                UnityEngine.Object.Destroy(g.Root);
            }
        }

        private void ClearAllGhosts()
        {
            if (_ghosts.Count == 0)
            {
                return;
            }

            foreach (var g in _ghosts.Values)
            {
                if (g != null && g.Root != null)
                {
                    UnityEngine.Object.Destroy(g.Root);
                }
            }

            _ghosts.Clear();
        }

        // -------------------------------------------------------------------
        // JSON DTOs (Unity's JsonUtility requires concrete fields, no dicts).
        // Field names MUST match the backend response exactly.
        // CS0649: JsonUtility writes these via reflection, so the compiler
        // can't see the assignments. Suppressed for the DTO block only.
        // -------------------------------------------------------------------
#pragma warning disable 0649
        [Serializable]
        private sealed class ActiveAircraftResponse
        {
            public bool ok;
            public long serverNowMs;
            public long freshMs;
            public ActiveAircraftEntry[] aircraft;
        }

        [Serializable]
        private sealed class ActiveAircraftEntry
        {
            public string sessionId;
            public string pilotName;
            public string callsign;
            public string craftName;
            public string craftType;
            public string craftMapIcon;
            /// <summary>
            /// Player-chosen "stock craft" key (e.g. "aeris4a"). When set, overrides
            /// <see cref="craftMapIcon"/> for silhouette selection. Empty = auto-detect.
            /// </summary>
            public string ghostCraftKey;
            public string bodyName;
            public string situation;
            public double lat;
            public double lon;
            public double aslAlt;
            public double radarAlt;
            public double heading;
            /// <summary>Ground track (deg); same as legacy <c>heading</c> when absent on the wire.</summary>
            public double surfaceTrack;
            public double pitch;
            public double roll;
            public double surfaceSpeed;
            public double verticalSpeed;
            public double throttle;
            public bool gearDown;
            public bool lights;
            public string lastTelemetryAt;
            public bool smoothedPositionValid;
            public double smoothedLat;
            public double smoothedLon;
            public double smoothedAslAlt;
        }
#pragma warning restore 0649

        private sealed class TowerGhostCombatTrigger : MonoBehaviour
        {
            private TowerGhostFleetBase _fleet;
            private string _sessionId = string.Empty;
            private float _nextHitAt;

            public void Init(TowerGhostFleetBase fleet, string sessionId)
            {
                _fleet = fleet;
                _sessionId = sessionId ?? string.Empty;
            }

            private void OnTriggerEnter(Collider other)
            {
                if (_fleet == null || string.IsNullOrEmpty(_sessionId))
                {
                    return;
                }
                if (Time.unscaledTime < _nextHitAt)
                {
                    return;
                }
                if (!IsFromActivePilotVessel(other))
                {
                    return;
                }
                _nextHitAt = Time.unscaledTime + 1.75f;
                _fleet.ReportGhostProximityHit(_sessionId);
            }

            private static bool IsFromActivePilotVessel(Collider c)
            {
                if (c == null)
                {
                    return false;
                }
                try
                {
                    if (!FlightGlobals.ready)
                    {
                        return false;
                    }
                    var av = FlightGlobals.ActiveVessel;
                    if (av == null)
                    {
                        return false;
                    }
                    var p = c.GetComponentInParent<Part>();
                    if (p != null && p.vessel == av)
                    {
                        return true;
                    }
                    var rb = c.attachedRigidbody;
                    if (rb == null)
                    {
                        return false;
                    }
                    if (av.rootPart != null && rb == av.rootPart.rb)
                    {
                        return true;
                    }
                    var parts = av.Parts;
                    if (parts == null)
                    {
                        return false;
                    }
                    for (var i = 0; i < parts.Count; i++)
                    {
                        var q = parts[i];
                        if (q != null && q.rb == rb)
                        {
                            return true;
                        }
                    }
                }
                catch (Exception)
                {
                    return false;
                }
                return false;
            }
        }

        /// <summary>
        /// Tiny billboard helper so the pilot-name / speed label always faces the player's
        /// camera. Cheaper than full <see cref="Quaternion.LookRotation"/> per frame because we
        /// only need yaw — the label is mounted on a vertical axis.
        /// </summary>
        private sealed class Billboard : MonoBehaviour
        {
            private void LateUpdate()
            {
                var cam = Camera.main;
                if (cam == null)
                {
                    return;
                }
                var dir = cam.transform.position - transform.position;
                dir.y = 0f;
                if (dir.sqrMagnitude < 0.0001f)
                {
                    return;
                }
                transform.rotation = Quaternion.LookRotation(-dir);
            }
        }
    }

    /// <summary>Ghost-fleet rendering pass for the Space Centre scene (tower window view).</summary>
    [KSPAddon(KSPAddon.Startup.SpaceCentre, false)]
    public sealed class TowerGhostFleetSpaceCentre : TowerGhostFleetBase
    {
    }

    /// <summary>Ghost-fleet rendering pass for the Flight scene (taxi/takeoff/pattern traffic).</summary>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public sealed class TowerGhostFleetFlight : TowerGhostFleetBase
    {
    }
}
