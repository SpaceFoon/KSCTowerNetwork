using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// In-game "Dragon Radar" window: shared room game state, player blips, ball blips,
    /// combat actions, and optional Dragon Radar crew-revive wish when all seven balls are homed to this room.
    /// </summary>
    public sealed class TowerDragonRadarGui : MonoBehaviour
    {
        private static TowerDragonRadarGui _instance;

        public static TowerDragonRadarGui Instance
        {
            get { return _instance; }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerDragonRadarGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerDragonRadarGui>();
        }

        private const float PanelWidth = 560f;
        private const float PanelHeight = 700f;
        private const float PollIntervalVisibleSeconds = 2f;
        private const float PollIntervalHiddenSeconds = 8f;
        private const float RadarSize = 360f;
        private const float SweepDegPerSecond = 90f;

        private const float PlayerRangeKm = 100f;
        private const float CarrierRangeKm = 300f;
        private const float DetailRangeKm = 10f;
        private const float ClaimRadiusMeters = 100f;

        /** Bump when `BuildRadarFaceTexture` output changes so upgrades do not keep a stale baked face. */
        private const int RadarFaceTextureVersion = 2;

        private bool _visible;
        private Rect _windowRect = new Rect(460f, 80f, PanelWidth, PanelHeight);
        private int _windowId;

        private bool _started;
        private string _statusLine = "Standby.";
        private bool _actionBusy;
        private float _sweepDeg;

        private readonly List<ActiveAircraftEntry> _aircraft = new List<ActiveAircraftEntry>(32);
        private readonly HashSet<string> _carrierSessions = new HashSet<string>(StringComparer.Ordinal);
        private DragonRadarState _gameState;
        private string _selectedSessionId = string.Empty;
        private string _selectedSessionCallsign = string.Empty;
        private string _selectedSessionPilot = string.Empty;
        private string _hailSinceIso = string.Empty;
        private bool _hailCursorSeeded;
        private string _hailCursorSessionId = string.Empty;
        private string _incomingHailFreq = string.Empty;
        private string _incomingHailFrom = string.Empty;
        private bool _crewReviveConsumeBusy;

        private Texture2D _texRadarFace;
        private int _radarFaceTextureVersion;
        private Texture2D _texSweep;
        private Texture2D _texBlipPlayer;
        private Texture2D _texBlipCarrier;
        private Texture2D _texBlipBall;
        private Texture2D _texBlipBallDetail;
        private Texture2D _texMarkerEdge;

        private bool _bdArmoryPresent;
        private bool _bdArmoryProbed;
        private readonly List<BoundBdEvent> _boundBdEvents = new List<BoundBdEvent>();
        private float _lastAutoCombatAt;
        private string _lastAutoCombatVictim = string.Empty;
        private string _lastAutoCombatKind = string.Empty;

        public Action OnRequestMinimize;

        /// <summary>
        /// When the RAD window is open and a shared hunt is loaded, ghost-fleet proxies can POST
        /// <c>dragon-radar/combat</c> "hit" after the local vessel intersects another pilot's hit sphere.
        /// </summary>
        public static bool TryPostGhostFleetCombatHit(string victimSessionId)
        {
            var g = Instance;
            if (g == null || !g.Visible)
            {
                return false;
            }
            if (g._gameState == null || g._gameState.balls == null || g._gameState.balls.Length == 0)
            {
                return false;
            }
            var victim = (victimSessionId ?? string.Empty).Trim();
            if (victim.Length == 0)
            {
                return false;
            }
            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (own.Length > 0 && string.Equals(victim, own, StringComparison.Ordinal))
            {
                return false;
            }
            g.StartCoroutine(g.PostCombat(victim, "hit", true));
            return true;
        }

        public bool Visible
        {
            get { return _visible; }
            set
            {
                if (_visible == value)
                {
                    return;
                }

                _visible = value;
                if (_visible)
                {
                    _statusLine = "Radar online.";
                }
            }
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _windowId = Guid.NewGuid().GetHashCode();
        }

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            TowerSkin.EnsureBuilt();
            EnsureTextures();
            ProbeBdArmory();
            StartCoroutine(PollLoop());
        }

        private void OnDestroy()
        {
            UnbindBdArmoryEvents();
            if (_instance == this)
            {
                _instance = null;
            }
        }

        private IEnumerator PollLoop()
        {
            yield return new WaitForSeconds(1f);
            while (true)
            {
                var wait = _visible ? PollIntervalVisibleSeconds : PollIntervalHiddenSeconds;
                if (_visible)
                {
                    yield return StartCoroutine(FetchActiveAircraft());
                    yield return StartCoroutine(FetchDragonRadarState());
                    yield return StartCoroutine(FetchInboundHails());
                }
                yield return new WaitForSeconds(wait);
            }
        }

        private void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            TowerSkin.EnsureBuilt();
            EnsureTextures();

            var maxX = Mathf.Max(0f, Screen.width - PanelWidth);
            var maxY = Mathf.Max(0f, Screen.height - PanelHeight);
            _windowRect.x = Mathf.Clamp(_windowRect.x, 0f, maxX);
            _windowRect.y = Mathf.Clamp(_windowRect.y, 0f, maxY);

            _windowRect = TowerClickBlock.GUILayoutWindow(_windowId, _windowRect, DrawWindow, GUIContent.none, TowerSkin.Panel);
        }

        private void DrawWindow(int id)
        {
            GUILayout.BeginVertical();

            if (TowerSkin.DrawTitleBar("DRAGON RADAR  ·  ROOM", true))
            {
                Visible = false;
                if (OnRequestMinimize != null)
                {
                    OnRequestMinimize();
                }
            }

            DrawHeaderStrip();
            GUILayout.Space(4f);

            var radarRect = GUILayoutUtility.GetRect(RadarSize, RadarSize, GUILayout.ExpandWidth(false));
            radarRect.x = Mathf.Round((PanelWidth - radarRect.width) * 0.5f) - 8f;
            radarRect.y = Mathf.Round(radarRect.y);
            DrawRadarSurface(radarRect);

            GUILayout.Space(6f);
            DrawRangeAndGameActions();
            GUILayout.Space(4f);
            DrawSelectionActions();
            GUILayout.Space(6f);
            GUILayout.Label(_statusLine, TowerSkin.Status);

            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 36f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
        }

        private void DrawHeaderStrip()
        {
            GUILayout.BeginHorizontal();
            var sid = (TowerModSettings.SessionId ?? string.Empty).Trim();
            GUILayout.Label("Room: " + (sid.Length > 0 ? sid : "—"), TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();
            GUILayout.Label(_bdArmoryPresent ? "BDA: READY" : "BDA: OFF", TowerSkin.BodyMuted, GUILayout.Width(90f));
            GUILayout.EndHorizontal();

            if (_gameState == null)
            {
                GUILayout.Label("No shared Dragon Ball map yet. Press START GAME.", TowerSkin.BodyMuted);
                return;
            }

            var carried = 0;
            var collected = 0;
            var loose = 0;
            for (var i = 0; i < _gameState.balls.Length; i++)
            {
                var b = _gameState.balls[i];
                if (b == null)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(b.collectedBySessionId))
                {
                    collected++;
                }
                else if (!string.IsNullOrEmpty(b.carrierSessionId))
                {
                    carried++;
                }
                else
                {
                    loose++;
                }
            }

            GUILayout.Label(
                "Map " + TrimForHud(_gameState.gameId, 8)
                + " · Body " + (_gameState.bodyName ?? "Kerbin")
                + " · Loose " + loose
                + " · Carried " + carried
                + " · Collected " + collected,
                TowerSkin.BodyMuted);
        }

        private void DrawRangeAndGameActions()
        {
            GUILayout.BeginHorizontal();
            GUI.enabled = !_actionBusy;
            if (GUILayout.Button("START GAME", TowerSkin.Button, GUILayout.Width(120f), GUILayout.Height(24f)))
            {
                StartCoroutine(PostStartGame());
            }

            if (GUILayout.Button("REFRESH", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(24f)))
            {
                StartCoroutine(FetchActiveAircraft());
                StartCoroutine(FetchDragonRadarState());
                StartCoroutine(FetchInboundHails());
            }
            DragonBallState nearestLoose;
            double nearestSurfaceM;
            GetNearestLooseBallSurfaceMeters(out nearestLoose, out nearestSurfaceM);
            var landed = IsActiveVesselLandedForDragonClaim();
            var canClaim = landed
                && nearestLoose != null
                && nearestSurfaceM <= ClaimRadiusMeters;
            GUI.enabled = !_actionBusy && canClaim;
            if (GUILayout.Button("CLAIM", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(24f)))
            {
                StartCoroutine(PostClaimBall(nearestLoose));
            }
            GUI.enabled = true;
            string claimHint;
            if (nearestLoose == null)
            {
                claimHint = "no ball";
            }
            else if (!landed)
            {
                claimHint = "~"
                    + Math.Round(nearestSurfaceM).ToString(CultureInfo.InvariantCulture)
                    + " m · land";
            }
            else if (!canClaim)
            {
                claimHint = "~"
                    + Math.Round(nearestSurfaceM).ToString(CultureInfo.InvariantCulture)
                    + " m";
            }
            else
            {
                claimHint = "~"
                    + Math.Round(nearestSurfaceM).ToString(CultureInfo.InvariantCulture)
                    + " m";
            }
            GUILayout.Label(claimHint, TowerSkin.BodyMuted, GUILayout.Width(120f));

            GUILayout.EndHorizontal();

            if (!string.IsNullOrEmpty(_incomingHailFreq))
            {
                GUILayout.BeginHorizontal(TowerSkin.Inset);
                GUILayout.Label(
                    "INBOUND HAIL " + _incomingHailFreq + " MHz"
                    + (string.IsNullOrEmpty(_incomingHailFrom) ? string.Empty : " · FROM " + TrimForHud(_incomingHailFrom, 18)),
                    TowerSkin.Body);
                GUILayout.FlexibleSpace();
                GUI.enabled = !_actionBusy;
                if (GUILayout.Button("TUNE", TowerSkin.ButtonActive, GUILayout.Width(80f), GUILayout.Height(22f)))
                {
                    TuneInboundHail();
                }
                if (GUILayout.Button("DISMISS", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(22f)))
                {
                    _incomingHailFreq = string.Empty;
                    _incomingHailFrom = string.Empty;
                }
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
        }

        private void DrawSelectionActions()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            if (string.IsNullOrEmpty(_selectedSessionId))
            {
                GUILayout.Label("Click a player blip to mark BDA combat.", TowerSkin.BodyMuted);
                GUILayout.EndVertical();
                return;
            }

            GUILayout.Label(
                "Selected: "
                + TrimForHud(_selectedSessionCallsign, 24)
                + "  (" + TrimForHud(_selectedSessionPilot, 24) + ")"
                + "  [" + _selectedSessionId + "]",
                TowerSkin.Body);

            GUILayout.BeginHorizontal();
            GUI.enabled = !_actionBusy;
            if (_bdArmoryPresent)
            {
                if (GUILayout.Button("BD HIT", TowerSkin.Button, GUILayout.Width(100f), GUILayout.Height(24f)))
                {
                    StartCoroutine(PostCombat(_selectedSessionId, "hit", false));
                }
                if (GUILayout.Button("BD KILL", TowerSkin.Button, GUILayout.Width(100f), GUILayout.Height(24f)))
                {
                    StartCoroutine(PostCombat(_selectedSessionId, "kill", false));
                }
            }
            else
            {
                GUILayout.Label("Install BDArmory to enable combat steal/drop actions.", TowerSkin.BodyMuted);
            }
            GUI.enabled = true;
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("CLEAR", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(24f)))
            {
                _selectedSessionId = string.Empty;
                _selectedSessionCallsign = string.Empty;
                _selectedSessionPilot = string.Empty;
            }
            GUILayout.EndHorizontal();
            GUILayout.EndVertical();
        }

        private void DrawRadarSurface(Rect r)
        {
            if (_texRadarFace == null)
            {
                EnsureTextures();
            }

            GUI.DrawTexture(r, _texRadarFace);
            DrawSweep(r);

            CelestialBody body;
            Vector3d refPos;
            double refLat;
            double refLon;
            if (!TryGetReference(out body, out refPos, out refLat, out refLon))
            {
                GUI.Label(new Rect(r.x + 10f, r.y + 8f, r.width - 20f, 20f), "No vessel/camera reference.", TowerSkin.BodyMuted);
                return;
            }

            var center = new Vector2(r.x + r.width * 0.5f, r.y + r.height * 0.5f);
            var radius = r.width * 0.5f - 14f;
            DrawRangeRings(center, radius);

            BuildCarrierIndex();
            DrawPlayerBlips(body, refPos, refLat, refLon, center, radius);
            DrawDragonBallBlips(body, refPos, refLat, refLon, center, radius);
            HandleRadarClick(r);
        }

        private void DrawSweep(Rect r)
        {
            if (_texSweep == null)
            {
                return;
            }

            var center = new Vector2(r.x + r.width * 0.5f, r.y + r.height * 0.5f);
            var lineH = r.height * 0.5f - 8f;
            _sweepDeg = (Time.unscaledTime * SweepDegPerSecond) % 360f;
            var old = GUI.matrix;
            GUIUtility.RotateAroundPivot(_sweepDeg, center);
            GUI.DrawTexture(new Rect(center.x - 1f, center.y - lineH, 2f, lineH), _texSweep);
            GUI.matrix = old;
        }

        private void DrawRangeRings(Vector2 center, float radius)
        {
            // Match tower web `TowerRadarScope`: ringFracs 0.25 / 0.5 / 0.75 / 1 and `.tower-radar-scope__ring` stroke.
            var ringRgb = new Color(0f, 1f, 102f / 255f, 0.38f);
            DrawRing(center, radius * 0.25f, ringRgb);
            DrawRing(center, radius * 0.50f, ringRgb);
            DrawRing(center, radius * 0.75f, ringRgb);
            DrawRing(center, radius, ringRgb);
            DrawTextAt(center.x - 10f, center.y - radius - 14f, "N");
            DrawTextAt(center.x + radius + 4f, center.y - 8f, "E");
            DrawTextAt(center.x - 8f, center.y + radius + 2f, "S");
            DrawTextAt(center.x - radius - 12f, center.y - 8f, "W");
        }

        private void DrawPlayerBlips(
            CelestialBody body,
            Vector3d refPos,
            double refLat,
            double refLon,
            Vector2 center,
            float radius)
        {
            for (var i = 0; i < _aircraft.Count; i++)
            {
                var a = _aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }

                var lat = EffectiveLat(a);
                var lon = EffectiveLon(a);
                var alt = EffectiveAslAlt(a);
                if (!string.IsNullOrEmpty(a.bodyName)
                    && body != null
                    && !string.Equals(a.bodyName, body.bodyName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                var wp = body.GetWorldSurfacePosition(lat, lon, alt);
                var distKm = Vector3d.Distance(refPos, wp) / 1000d;
                var carriesBall = _carrierSessions.Contains(a.sessionId);
                var maxVisibleKm = carriesBall ? CarrierRangeKm : PlayerRangeKm;
                if (distKm > maxVisibleKm)
                {
                    continue;
                }

                var brg = BearingDeg(refLat, refLon, lat, lon);
                var dirOnly = carriesBall && distKm > PlayerRangeKm;
                var rr = (float)Math.Min(1d, distKm / PlayerRangeKm);
                if (dirOnly)
                {
                    rr = 1f;
                }

                var blipPos = PolarToScreen(center, radius * rr, brg);
                var tex = carriesBall ? _texBlipCarrier : _texBlipPlayer;
                DrawBlip(tex, blipPos, carriesBall ? 8f : 6f);

                if (!dirOnly)
                {
                    var cs = SafeCallsign(a);
                    DrawTextAt(blipPos.x + 5f, blipPos.y - 8f, TrimForHud(cs, 10));
                }
            }
        }

        private void DrawDragonBallBlips(
            CelestialBody body,
            Vector3d refPos,
            double refLat,
            double refLon,
            Vector2 center,
            float radius)
        {
            if (_gameState == null || _gameState.balls == null)
            {
                return;
            }

            DragonBallState nearestLoose;
            double nearestSurfaceM;
            GetNearestLooseBallSurfaceMeters(out nearestLoose, out nearestSurfaceM);
            var nearestId = nearestLoose != null ? nearestLoose.id : null;

            for (var i = 0; i < _gameState.balls.Length; i++)
            {
                var b = _gameState.balls[i];
                if (b == null)
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(b.carrierSessionId) || !string.IsNullOrEmpty(b.collectedBySessionId))
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(b.bodyName)
                    && body != null
                    && !string.Equals(b.bodyName, body.bodyName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var isNearestLoose = !string.IsNullOrEmpty(nearestId)
                    && !string.IsNullOrEmpty(b.id)
                    && string.Equals(b.id, nearestId, StringComparison.Ordinal);

                var wp = body.GetWorldSurfacePosition(b.lat, b.lon, b.aslAlt);
                var distKm = Vector3d.Distance(refPos, wp) / 1000d;
                if (distKm > CarrierRangeKm && !isNearestLoose)
                {
                    continue;
                }

                var brg = BearingDeg(refLat, refLon, b.lat, b.lon);
                var nearDetail = distKm <= DetailRangeKm;
                var rr = nearDetail ? (float)Math.Min(1d, distKm / PlayerRangeKm) : 1f;
                var blipPos = PolarToScreen(center, radius * rr, brg);
                DrawBlip(nearDetail ? _texBlipBallDetail : _texBlipBall, blipPos, nearDetail ? 8f : 6f);
                if (nearDetail)
                {
                    DrawTextAt(blipPos.x + 5f, blipPos.y - 8f, b.id.ToUpperInvariant());
                }
                else if (isNearestLoose && distKm > CarrierRangeKm)
                {
                    var km = (int)Math.Max(1, Math.Round(nearestSurfaceM / 1000.0));
                    DrawTextAt(
                        blipPos.x + 5f,
                        blipPos.y - 8f,
                        "~" + km.ToString(CultureInfo.InvariantCulture) + " km");
                }
            }
        }

        private void HandleRadarClick(Rect radarRect)
        {
            var e = Event.current;
            if (e == null || e.type != EventType.MouseDown || e.button != 0)
            {
                return;
            }
            if (!radarRect.Contains(e.mousePosition))
            {
                return;
            }

            CelestialBody body;
            Vector3d refPos;
            double refLat;
            double refLon;
            if (!TryGetReference(out body, out refPos, out refLat, out refLon))
            {
                return;
            }

            var center = new Vector2(radarRect.x + radarRect.width * 0.5f, radarRect.y + radarRect.height * 0.5f);
            var radius = radarRect.width * 0.5f - 14f;
            var bestDistSq = float.MaxValue;
            string bestSession = null;
            string bestCallsign = null;
            string bestPilot = null;
            for (var i = 0; i < _aircraft.Count; i++)
            {
                var a = _aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }

                var lat = EffectiveLat(a);
                var lon = EffectiveLon(a);
                var alt = EffectiveAslAlt(a);
                if (!string.IsNullOrEmpty(a.bodyName)
                    && body != null
                    && !string.Equals(a.bodyName, body.bodyName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                var wp = body.GetWorldSurfacePosition(lat, lon, alt);
                var distKm = Vector3d.Distance(refPos, wp) / 1000d;
                var carriesBall = _carrierSessions.Contains(a.sessionId);
                var maxVisibleKm = carriesBall ? CarrierRangeKm : PlayerRangeKm;
                if (distKm > maxVisibleKm)
                {
                    continue;
                }

                var brg = BearingDeg(refLat, refLon, lat, lon);
                var dirOnly = carriesBall && distKm > PlayerRangeKm;
                var rr = dirOnly ? 1f : (float)Math.Min(1d, distKm / PlayerRangeKm);
                var p = PolarToScreen(center, radius * rr, brg);
                var dx = e.mousePosition.x - p.x;
                var dy = e.mousePosition.y - p.y;
                var d2 = dx * dx + dy * dy;
                if (d2 < 14f * 14f && d2 < bestDistSq)
                {
                    bestDistSq = d2;
                    bestSession = a.sessionId;
                    bestCallsign = SafeCallsign(a);
                    bestPilot = SafePilot(a);
                }
            }

            if (!string.IsNullOrEmpty(bestSession))
            {
                _selectedSessionId = bestSession;
                _selectedSessionCallsign = bestCallsign ?? string.Empty;
                _selectedSessionPilot = bestPilot ?? string.Empty;
                _statusLine = "Selected " + _selectedSessionCallsign + ".";
                e.Use();
            }
        }

        private void DrawBlip(Texture2D tex, Vector2 p, float size)
        {
            if (tex == null)
            {
                return;
            }
            GUI.DrawTexture(new Rect(p.x - size * 0.5f, p.y - size * 0.5f, size, size), tex);
        }

        private static Vector2 PolarToScreen(Vector2 center, float radius, double bearingDeg)
        {
            var br = (float)(bearingDeg * Math.PI / 180.0);
            return new Vector2(
                center.x + radius * Mathf.Sin(br),
                center.y - radius * Mathf.Cos(br));
        }

        private static double BearingDeg(double lat0, double lon0, double lat1, double lon1)
        {
            var p0 = lat0 * Math.PI / 180.0;
            var p1 = lat1 * Math.PI / 180.0;
            var dl = (lon1 - lon0) * Math.PI / 180.0;
            var y = Math.Sin(dl) * Math.Cos(p1);
            var x = Math.Cos(p0) * Math.Sin(p1) - Math.Sin(p0) * Math.Cos(p1) * Math.Cos(dl);
            var t = Math.Atan2(y, x);
            return (t * 180.0 / Math.PI + 360.0) % 360.0;
        }

        /// <summary>
        /// Screen point on a range circle: same north-up convention as <see cref="PolarToScreen"/> / tower web PPI
        /// (<c>x = cx + r·sin(θ)</c>, <c>y = cy − r·cos(θ)</c>, θ = bearing from north, clockwise).
        /// </summary>
        private static Vector2 RingPointNorthUp(Vector2 center, float radius, float angleRad)
        {
            return new Vector2(
                center.x + radius * Mathf.Sin(angleRad),
                center.y - radius * Mathf.Cos(angleRad));
        }

        private void DrawRing(Vector2 center, float radius, Color color)
        {
            const int step = 96;
            var prev = RingPointNorthUp(center, radius, 0f);
            for (var i = 1; i <= step; i++)
            {
                var a = (i / (float)step) * (Mathf.PI * 2f);
                var p = RingPointNorthUp(center, radius, a);
                DrawLine(prev, p, color, 1.15f);
                prev = p;
            }
        }

        private void DrawLine(Vector2 a, Vector2 b, Color color, float thickness)
        {
            var old = GUI.color;
            GUI.color = color;
            var d = b - a;
            var ang = Mathf.Rad2Deg * Mathf.Atan2(d.y, d.x);
            var len = d.magnitude;
            var oldMatrix = GUI.matrix;
            GUIUtility.RotateAroundPivot(ang, a);
            GUI.DrawTexture(new Rect(a.x, a.y - thickness * 0.5f, len, thickness), _texMarkerEdge);
            GUI.matrix = oldMatrix;
            GUI.color = old;
        }

        private void DrawTextAt(float x, float y, string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return;
            }
            GUI.Label(new Rect(x, y, 64f, 16f), text, TowerSkin.BodyMuted);
        }

        private bool TryGetReference(
            out CelestialBody body,
            out Vector3d worldPos,
            out double lat,
            out double lon)
        {
            body = null;
            worldPos = Vector3d.zero;
            lat = 0d;
            lon = 0d;

            try
            {
                var av = FlightGlobals.ActiveVessel;
                if (av != null && av.mainBody != null)
                {
                    body = av.mainBody;
                    worldPos = av.GetWorldPos3D();
                    lat = av.latitude;
                    lon = av.longitude;
                    return true;
                }
            }
            catch (Exception)
            {
                // ignore; fallback to camera path
            }

            try
            {
                body = Planetarium.fetch != null ? Planetarium.fetch.Home : null;
                if (body == null || Camera.main == null)
                {
                    return false;
                }
                worldPos = Camera.main.transform.position;
                lat = body.GetLatitude(worldPos);
                lon = body.GetLongitude(worldPos);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private IEnumerator FetchActiveAircraft()
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
                    ApplyActiveAircraftSnapshot(udpReply);
                    yield break;
                }

                if (!TowerModSettings.LiveUdpFallbackHttp)
                {
                    _statusLine = "Active-aircraft UDP failed: " + (string.IsNullOrEmpty(udpError) ? "no reply" : udpError);
                    yield break;
                }
            }

            var url = TowerModSettings.ApiBaseUrl + "/tower/active-aircraft";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 6;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (IsUnityWebRequestFailure(req))
                {
                    _statusLine = FormatTowerApiFailure("Active-aircraft fetch failed", req);
                    yield break;
                }

                var txt = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(txt))
                {
                    _aircraft.Clear();
                    yield break;
                }
                ApplyActiveAircraftSnapshot(txt);
            }
        }

        private void ApplyActiveAircraftSnapshot(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                _aircraft.Clear();
                return;
            }

            ActiveAircraftResponse parsed;
            try
            {
                parsed = JsonUtility.FromJson<ActiveAircraftResponse>(json);
            }
            catch (Exception ex)
            {
                _statusLine = "Active-aircraft parse failed: " + ex.Message;
                return;
            }

            _aircraft.Clear();
            if (parsed == null || parsed.aircraft == null)
            {
                return;
            }

            for (var i = 0; i < parsed.aircraft.Length; i++)
            {
                var a = parsed.aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }
                _aircraft.Add(a);
            }
        }

        private IEnumerator FetchDragonRadarState()
        {
            var url = SessionUrl("/dragon-radar");
            if (string.IsNullOrEmpty(url))
            {
                yield break;
            }

            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 6;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (IsUnityWebRequestFailure(req))
                {
                    _statusLine = FormatTowerApiFailure("Dragon radar fetch failed", req);
                    yield break;
                }

                var txt = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(txt))
                {
                    _gameState = null;
                    _carrierSessions.Clear();
                    yield break;
                }

                DragonRadarEnvelope parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<DragonRadarEnvelope>(txt);
                }
                catch (Exception ex)
                {
                    _statusLine = "Dragon radar parse failed: " + ex.Message;
                    yield break;
                }

                _gameState = parsed != null ? parsed.state : null;
                BuildCarrierIndex();
                if (_gameState != null)
                {
                    StartCoroutine(TryConsumeCrewReviveOffer());
                }
            }
        }

        private IEnumerator TryConsumeCrewReviveOffer()
        {
            if (_crewReviveConsumeBusy)
            {
                yield break;
            }

            var offer = _gameState != null ? _gameState.crewReviveOffer : null;
            if (offer == null || !string.IsNullOrEmpty(offer.consumedAt))
            {
                yield break;
            }

            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(own) || !string.Equals(offer.targetSessionId, own, StringComparison.Ordinal))
            {
                yield break;
            }

            _crewReviveConsumeBusy = true;
            try
            {
                var revived = ReviveDeadOrMissingCrewForDragonRadarWish();
                yield return StartCoroutine(PostCrewReviveAck());
                if (revived > 0)
                {
                    _statusLine = "Dragon Radar wish: restored " + revived + " crew to Available.";
                    ScreenMessages.PostScreenMessage(
                        "Dragon Radar wish — crew roster restored (" + revived + ").",
                        6f,
                        ScreenMessageStyle.UPPER_CENTER);
                }
                else
                {
                    _statusLine = "Dragon Radar crew-revive wish acknowledged (no Dead/Missing crew in roster).";
                }
            }
            finally
            {
                _crewReviveConsumeBusy = false;
            }
        }

        private static int ReviveDeadOrMissingCrewForDragonRadarWish()
        {
            var n = 0;
            try
            {
                var roster = HighLogic.CurrentGame != null ? HighLogic.CurrentGame.CrewRoster : null;
                if (roster == null)
                {
                    return 0;
                }

                foreach (var pcm in roster.Crew)
                {
                    if (pcm == null)
                    {
                        continue;
                    }
                    if (pcm.rosterStatus != ProtoCrewMember.RosterStatus.Dead
                        && pcm.rosterStatus != ProtoCrewMember.RosterStatus.Missing)
                    {
                        continue;
                    }
                    pcm.rosterStatus = ProtoCrewMember.RosterStatus.Available;
                    n++;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Dragon Radar crew revive: " + ex.Message);
            }
            return n;
        }

        private IEnumerator PostCrewReviveAck()
        {
            var url = SessionUrl("/dragon-radar/crew-revive-ack");
            if (string.IsNullOrEmpty(url))
            {
                yield break;
            }

            using (var req = NewJsonRequest(url, "POST", "{}"))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (IsUnityWebRequestFailure(req))
                {
                    _statusLine = FormatTowerApiFailure("Crew-revive ack failed", req);
                }
            }

            StartCoroutine(FetchDragonRadarState());
        }

        private IEnumerator FetchInboundHails()
        {
            var ownSid = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (!string.Equals(_hailCursorSessionId, ownSid, StringComparison.Ordinal))
            {
                _hailCursorSessionId = ownSid;
                _hailSinceIso = string.Empty;
                _hailCursorSeeded = false;
                _incomingHailFreq = string.Empty;
                _incomingHailFrom = string.Empty;
            }

            var url = SessionUrl("/messages");
            if (string.IsNullOrEmpty(url))
            {
                yield break;
            }
            if (!string.IsNullOrEmpty(_hailSinceIso))
            {
                url += "?since=" + UnityWebRequest.EscapeURL(_hailSinceIso);
            }

            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 6;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (IsUnityWebRequestFailure(req))
                {
                    yield break;
                }

                var txt = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(txt))
                {
                    yield break;
                }

                AcarsMessagesEnvelope parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<AcarsMessagesEnvelope>(txt);
                }
                catch
                {
                    yield break;
                }
                if (parsed == null || parsed.messages == null)
                {
                    yield break;
                }
                if (!_hailCursorSeeded)
                {
                    for (var i = 0; i < parsed.messages.Length; i++)
                    {
                        var m = parsed.messages[i];
                        if (m == null || string.IsNullOrEmpty(m.createdAt))
                        {
                            continue;
                        }
                        if (string.IsNullOrEmpty(_hailSinceIso) || string.CompareOrdinal(m.createdAt, _hailSinceIso) > 0)
                        {
                            _hailSinceIso = m.createdAt;
                        }
                    }
                    _hailCursorSeeded = true;
                    yield break;
                }

                for (var i = 0; i < parsed.messages.Length; i++)
                {
                    var m = parsed.messages[i];
                    if (m == null)
                    {
                        continue;
                    }
                    if (!string.IsNullOrEmpty(m.createdAt)
                        && (string.IsNullOrEmpty(_hailSinceIso) || string.CompareOrdinal(m.createdAt, _hailSinceIso) > 0))
                    {
                        _hailSinceIso = m.createdAt;
                    }

                    string targetSid;
                    string freq;
                    if (!TryParseRadarHail(m.body, out targetSid, out freq))
                    {
                        continue;
                    }
                    if (!string.Equals(targetSid, ownSid, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    _incomingHailFreq = freq;
                    _incomingHailFrom = m.fromUserId ?? string.Empty;
                }
            }
        }

        private IEnumerator PostStartGame()
        {
            if (_actionBusy)
            {
                yield break;
            }

            _actionBusy = true;
            _statusLine = "Starting shared Dragon Radar game…";
            var url = SessionUrl("/dragon-radar/start");
            if (string.IsNullOrEmpty(url))
            {
                _statusLine = "No session id.";
                _actionBusy = false;
                yield break;
            }

            var bodyName = "Kerbin";
            try
            {
                if (FlightGlobals.ActiveVessel != null && FlightGlobals.ActiveVessel.mainBody != null)
                {
                    bodyName = FlightGlobals.ActiveVessel.mainBody.bodyName ?? "Kerbin";
                }
            }
            catch (Exception)
            {
                // ignore
            }

            var payload = "{\"bodyName\":\"" + JsonEscape(bodyName) + "\"}";
            using (var req = NewJsonRequest(url, "POST", payload))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (IsUnityWebRequestFailure(req))
                {
                    _statusLine = FormatTowerApiFailure("Start game failed", req);
                    _actionBusy = false;
                    yield break;
                }
            }

            _statusLine = "Dragon Radar game started.";
            _actionBusy = false;
            StartCoroutine(FetchDragonRadarState());
        }

        private IEnumerator PostClaimBall(DragonBallState ball)
        {
            if (_actionBusy || ball == null || string.IsNullOrEmpty(ball.id))
            {
                yield break;
            }

            _actionBusy = true;
            _statusLine = "Claiming " + ball.id.ToUpperInvariant() + "…";
            var url = SessionUrl("/dragon-radar/claim");
            if (string.IsNullOrEmpty(url))
            {
                _statusLine = "No session id.";
                _actionBusy = false;
                yield break;
            }

            var payload = "{\"ballId\":\"" + JsonEscape(ball.id) + "\"}";
            using (var req = NewJsonRequest(url, "POST", payload))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (IsUnityWebRequestFailure(req))
                {
                    _statusLine = FormatTowerApiFailure("Claim failed", req);
                    _actionBusy = false;
                    yield break;
                }
            }

            _statusLine = "Claim request sent for " + ball.id.ToUpperInvariant() + ".";
            _actionBusy = false;
            StartCoroutine(FetchDragonRadarState());
        }

        private IEnumerator PostCombat(string victimSessionId, string kind, bool fromAuto)
        {
            if (_actionBusy && !fromAuto)
            {
                yield break;
            }
            if (string.IsNullOrEmpty(victimSessionId))
            {
                yield break;
            }
            var ownSession = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (ownSession.Length == 0)
            {
                yield break;
            }

            if (fromAuto && Time.unscaledTime - _lastAutoCombatAt < 2f
                && string.Equals(_lastAutoCombatVictim, victimSessionId, StringComparison.Ordinal)
                && string.Equals(_lastAutoCombatKind, kind, StringComparison.Ordinal))
            {
                yield break;
            }

            if (!fromAuto)
            {
                _actionBusy = true;
            }

            var url = SessionUrl("/dragon-radar/combat");
            if (string.IsNullOrEmpty(url))
            {
                if (!fromAuto)
                {
                    _actionBusy = false;
                }
                yield break;
            }

            var payload = "{\"victimSessionId\":\"" + JsonEscape(victimSessionId)
                + "\",\"kind\":\"" + JsonEscape(kind) + "\"}";

            using (var req = NewJsonRequest(url, "POST", payload))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (IsUnityWebRequestFailure(req))
                {
                    if (!fromAuto)
                    {
                        _statusLine = FormatTowerApiFailure("Combat mark failed", req);
                        _actionBusy = false;
                    }
                    yield break;
                }
            }

            _lastAutoCombatAt = Time.unscaledTime;
            _lastAutoCombatVictim = victimSessionId;
            _lastAutoCombatKind = kind;
            if (!fromAuto)
            {
                _statusLine = "Combat " + kind.ToUpperInvariant() + " sent for " + TrimForHud(_selectedSessionCallsign, 16) + ".";
                _actionBusy = false;
            }
            else
            {
                _statusLine = "Combat " + kind.ToUpperInvariant() + " vs " + TrimForHud(victimSessionId, 14) + ".";
            }
            StartCoroutine(FetchDragonRadarState());
        }

        private static UnityWebRequest NewJsonRequest(string url, string method, string json)
        {
            var req = new UnityWebRequest(url, method);
            var body = string.IsNullOrEmpty(json) ? "{}" : json;
            req.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(body));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            return req;
        }

        private static bool IsUnityWebRequestFailure(UnityWebRequest req)
        {
            if (req == null)
            {
                return true;
            }
            if (req.isNetworkError)
            {
                return true;
            }
            var code = req.responseCode;
            if (code <= 0)
            {
                // Some transports surface failures without a positive HTTP code.
                return req.isHttpError;
            }
            if (code < 200 || code > 299)
            {
                return true;
            }
            // Treat odd "HTTP 2xx but flagged as error" cases as success.
            return false;
        }

        private static string FormatTowerApiFailure(string prefix, UnityWebRequest req)
        {
            if (req == null)
            {
                return prefix + ".";
            }

            var code = req.responseCode;
            var bits = new List<string>();
            bits.Add(prefix);
            bits.Add("HTTP " + code.ToString(CultureInfo.InvariantCulture));

            if (!string.IsNullOrEmpty(req.error))
            {
                bits.Add(req.error.Trim());
            }

            var body = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
            if (!string.IsNullOrEmpty(body))
            {
                var oneLine = body.Replace("\r", " ").Replace("\n", " ").Trim();
                if (oneLine.Length > 220)
                {
                    oneLine = oneLine.Substring(0, 220) + "…";
                }
                if (!string.IsNullOrEmpty(oneLine))
                {
                    bits.Add(oneLine);
                }
            }

            return string.Join(" · ", bits.ToArray());
        }

        private string SessionUrl(string suffix)
        {
            var sid = (TowerModSettings.SessionId ?? string.Empty).Trim();
            if (sid.Length == 0)
            {
                return null;
            }
            return TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sid) + suffix;
        }

        private void BuildCarrierIndex()
        {
            _carrierSessions.Clear();
            if (_gameState == null || _gameState.balls == null)
            {
                return;
            }
            for (var i = 0; i < _gameState.balls.Length; i++)
            {
                var b = _gameState.balls[i];
                if (b == null || string.IsNullOrEmpty(b.carrierSessionId))
                {
                    continue;
                }
                _carrierSessions.Add(b.carrierSessionId);
            }
        }

        private static bool TryNormalizeFrequency(string raw, out string canonical)
        {
            canonical = string.Empty;
            if (string.IsNullOrEmpty(raw))
            {
                return false;
            }
            double mhz;
            if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out mhz))
            {
                return false;
            }
            mhz = Math.Round(mhz * 40.0, MidpointRounding.AwayFromZero) / 40.0;
            if (mhz < 100.0 || mhz > 199.999)
            {
                return false;
            }
            canonical = string.Format(CultureInfo.InvariantCulture, "{0:000.000}", mhz);
            return true;
        }

        private void TuneInboundHail()
        {
            if (string.IsNullOrEmpty(_incomingHailFreq))
            {
                return;
            }
            double mhz;
            if (!double.TryParse(_incomingHailFreq, NumberStyles.Float, CultureInfo.InvariantCulture, out mhz))
            {
                _statusLine = "Inbound hail has invalid frequency.";
                return;
            }

            TowerRadioGui.RequestTuneFromIvaCommRadio(mhz);
            _statusLine = "Tuning radio to inbound hail " + _incomingHailFreq + " MHz.";
            _incomingHailFreq = string.Empty;
            _incomingHailFrom = string.Empty;
        }

        private static bool TryParseRadarHail(string body, out string targetSid, out string freq)
        {
            targetSid = string.Empty;
            freq = string.Empty;
            if (string.IsNullOrEmpty(body))
            {
                return false;
            }
            if (body.IndexOf("[RADAR HAIL]", StringComparison.OrdinalIgnoreCase) < 0)
            {
                return false;
            }

            targetSid = ReadTokenValue(body, "target=");
            var rawFreq = ReadTokenValue(body, "freq=");
            if (string.IsNullOrEmpty(targetSid) || string.IsNullOrEmpty(rawFreq))
            {
                return false;
            }

            return TryNormalizeFrequency(rawFreq, out freq);
        }

        private static string ReadTokenValue(string src, string marker)
        {
            if (string.IsNullOrEmpty(src) || string.IsNullOrEmpty(marker))
            {
                return string.Empty;
            }
            var i = src.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (i < 0)
            {
                return string.Empty;
            }
            i += marker.Length;
            var j = i;
            while (j < src.Length)
            {
                var c = src[j];
                if (char.IsWhiteSpace(c))
                {
                    break;
                }
                j++;
            }
            if (j <= i)
            {
                return string.Empty;
            }
            return src.Substring(i, j - i).Trim();
        }

        private static string JsonEscape(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static string TrimForHud(string text, int max)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "—";
            }
            return text.Length <= max ? text : text.Substring(0, max);
        }

        private static string SafeCallsign(ActiveAircraftEntry a)
        {
            if (!string.IsNullOrEmpty(a.callsign))
            {
                return a.callsign.Trim();
            }
            if (!string.IsNullOrEmpty(a.pilotName))
            {
                return a.pilotName.Trim();
            }
            return a.sessionId;
        }

        private static string SafePilot(ActiveAircraftEntry a)
        {
            if (!string.IsNullOrEmpty(a.pilotName))
            {
                return a.pilotName.Trim();
            }
            return "Pilot";
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

        private static bool IsActiveVesselLandedForDragonClaim()
        {
            try
            {
                var v = FlightGlobals.ActiveVessel;
                if (v == null)
                {
                    return false;
                }
                return v.situation == Vessel.Situations.LANDED || v.situation == Vessel.Situations.SPLASHED;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static double GreatCircleMetersOnBody(
            CelestialBody body,
            double lat0,
            double lon0,
            double lat1,
            double lon1)
        {
            if (body == null)
            {
                return double.PositiveInfinity;
            }
            var radiusM = body.Radius;
            var dLat = (lat1 - lat0) * Math.PI / 180.0;
            var dLon = (lon1 - lon0) * Math.PI / 180.0;
            var p0 = lat0 * Math.PI / 180.0;
            var p1 = lat1 * Math.PI / 180.0;
            var a = Math.Sin(dLat / 2.0) * Math.Sin(dLat / 2.0)
                    + Math.Cos(p0) * Math.Cos(p1) * Math.Sin(dLon / 2.0) * Math.Sin(dLon / 2.0);
            var c = 2.0 * Math.Atan2(Math.Sqrt(Math.Max(0.0, a)), Math.Sqrt(Math.Max(0.0, 1.0 - a)));
            return radiusM * c;
        }

        private void GetNearestLooseBallSurfaceMeters(out DragonBallState bestBall, out double bestMeters)
        {
            bestBall = null;
            bestMeters = double.MaxValue;
            if (_gameState == null || _gameState.balls == null)
            {
                return;
            }

            CelestialBody body;
            Vector3d refPos;
            double refLat;
            double refLon;
            if (!TryGetReference(out body, out refPos, out refLat, out refLon))
            {
                return;
            }

            for (var i = 0; i < _gameState.balls.Length; i++)
            {
                var b = _gameState.balls[i];
                if (b == null)
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(b.carrierSessionId) || !string.IsNullOrEmpty(b.collectedBySessionId))
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(b.bodyName)
                    && body != null
                    && !string.Equals(b.bodyName, body.bodyName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                var surfaceM = GreatCircleMetersOnBody(body, refLat, refLon, b.lat, b.lon);
                if (surfaceM < bestMeters)
                {
                    bestMeters = surfaceM;
                    bestBall = b;
                }
            }
        }

        private void EnsureTextures()
        {
            if (_texRadarFace != null && _radarFaceTextureVersion != RadarFaceTextureVersion)
            {
                UnityEngine.Object.Destroy(_texRadarFace);
                _texRadarFace = null;
            }
            if (_texRadarFace == null)
            {
                _texRadarFace = BuildRadarFaceTexture(512);
                _radarFaceTextureVersion = RadarFaceTextureVersion;
            }
            if (_texSweep == null) _texSweep = SolidTex(new Color32(120, 255, 170, 180));
            if (_texBlipPlayer == null) _texBlipPlayer = SolidTex(new Color32(180, 255, 190, 255));
            if (_texBlipCarrier == null) _texBlipCarrier = SolidTex(new Color32(255, 150, 150, 255));
            if (_texBlipBall == null) _texBlipBall = SolidTex(new Color32(255, 200, 80, 240));
            if (_texBlipBallDetail == null) _texBlipBallDetail = SolidTex(new Color32(255, 230, 120, 255));
            if (_texMarkerEdge == null) _texMarkerEdge = SolidTex(new Color32(120, 180, 120, 255));
        }

        private static Texture2D SolidTex(Color32 c)
        {
            var t = new Texture2D(2, 2, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp
            };
            t.SetPixels32(new[] { c, c, c, c });
            t.Apply(false, true);
            return t;
        }

        private static Texture2D BuildRadarFaceTexture(int size)
        {
            var t = new Texture2D(size, size, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            var px = new Color32[size * size];
            var cx = (size - 1) * 0.5f;
            var cy = (size - 1) * 0.5f;
            var rad = size * 0.48f;

            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    var dx = x - cx;
                    var dy = y - cy;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    var idx = y * size + x;
                    if (d > rad)
                    {
                        px[idx] = new Color32(0, 0, 0, 0);
                        continue;
                    }

                    var norm = d / rad;
                    var v = Mathf.Clamp01(1f - norm * 0.7f);
                    byte g = (byte)(40 + 50 * v);
                    byte b = (byte)(20 + 20 * v);
                    // Smooth face only (tower web PPI draws range rings as vector strokes on top).
                    px[idx] = new Color32(12, g, b, 230);
                }
            }

            t.SetPixels32(px);
            t.Apply(false, true);
            return t;
        }

        private void ProbeBdArmory()
        {
            if (_bdArmoryProbed)
            {
                return;
            }
            _bdArmoryProbed = true;
            try
            {
                var asms = AppDomain.CurrentDomain.GetAssemblies();
                for (var i = 0; i < asms.Length; i++)
                {
                    var asm = asms[i];
                    if (asm == null)
                    {
                        continue;
                    }
                    var name = asm.GetName().Name;
                    if (string.IsNullOrEmpty(name) || name.IndexOf("BDArmory", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    _bdArmoryPresent = true;
                    TryBindBdEvents(asm);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] BDA probe failed: " + ex.Message);
            }
        }

        private void TryBindBdEvents(Assembly asm)
        {
            Type[] types;
            try
            {
                types = asm.GetTypes();
            }
            catch
            {
                return;
            }

            for (var i = 0; i < types.Length; i++)
            {
                var t = types[i];
                if (t == null)
                {
                    continue;
                }

                EventInfo[] events;
                try
                {
                    events = t.GetEvents(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                }
                catch
                {
                    continue;
                }

                for (var e = 0; e < events.Length; e++)
                {
                    var ev = events[e];
                    if (ev == null || ev.EventHandlerType == null)
                    {
                        continue;
                    }

                    var name = ev.Name ?? string.Empty;
                    var lower = name.ToLowerInvariant();
                    var kind = lower.IndexOf("hit", StringComparison.Ordinal) >= 0 ? "hit"
                        : lower.IndexOf("kill", StringComparison.Ordinal) >= 0 || lower.IndexOf("destroy", StringComparison.Ordinal) >= 0
                            ? "kill"
                            : string.Empty;
                    if (kind.Length == 0)
                    {
                        continue;
                    }

                    var invoke = ev.EventHandlerType.GetMethod("Invoke");
                    if (invoke == null)
                    {
                        continue;
                    }

                    var ps = invoke.GetParameters();
                    Delegate del = null;
                    if (ps.Length == 2
                        && typeof(Vessel).IsAssignableFrom(ps[0].ParameterType)
                        && typeof(Vessel).IsAssignableFrom(ps[1].ParameterType))
                    {
                        del = kind == "hit"
                            ? Delegate.CreateDelegate(ev.EventHandlerType, this, "OnBdHitVessels", false)
                            : Delegate.CreateDelegate(ev.EventHandlerType, this, "OnBdKillVessels", false);
                    }
                    else if (ps.Length == 1 && typeof(Vessel).IsAssignableFrom(ps[0].ParameterType))
                    {
                        del = kind == "hit"
                            ? Delegate.CreateDelegate(ev.EventHandlerType, this, "OnBdHitVesselOnly", false)
                            : Delegate.CreateDelegate(ev.EventHandlerType, this, "OnBdKillVesselOnly", false);
                    }

                    if (del == null)
                    {
                        continue;
                    }

                    try
                    {
                        ev.AddEventHandler(null, del);
                        _boundBdEvents.Add(new BoundBdEvent { Event = ev, Handler = del });
                    }
                    catch
                    {
                        // ignore unsupported handlers
                    }
                }
            }
        }

        private void UnbindBdArmoryEvents()
        {
            for (var i = 0; i < _boundBdEvents.Count; i++)
            {
                var b = _boundBdEvents[i];
                if (b == null || b.Event == null || b.Handler == null)
                {
                    continue;
                }
                try
                {
                    b.Event.RemoveEventHandler(null, b.Handler);
                }
                catch
                {
                    // ignore
                }
            }
            _boundBdEvents.Clear();
        }

        private void OnBdHitVessels(Vessel attacker, Vessel victim)
        {
            HandleBdCombatEvent(attacker, victim, "hit");
        }

        private void OnBdKillVessels(Vessel attacker, Vessel victim)
        {
            HandleBdCombatEvent(attacker, victim, "kill");
        }

        private void OnBdHitVesselOnly(Vessel victim)
        {
            HandleBdCombatEvent(FlightGlobals.ActiveVessel, victim, "hit");
        }

        private void OnBdKillVesselOnly(Vessel victim)
        {
            HandleBdCombatEvent(FlightGlobals.ActiveVessel, victim, "kill");
        }

        private void HandleBdCombatEvent(Vessel attacker, Vessel victim, string kind)
        {
            if (attacker == null || victim == null)
            {
                return;
            }
            if (FlightGlobals.ActiveVessel == null || attacker != FlightGlobals.ActiveVessel)
            {
                return;
            }

            var victimName = (victim.vesselName ?? string.Empty).Trim();
            if (victimName.Length == 0)
            {
                return;
            }

            string victimSessionId = null;
            for (var i = 0; i < _aircraft.Count; i++)
            {
                var a = _aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.craftName) || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }
                if (string.Equals(a.craftName.Trim(), victimName, StringComparison.OrdinalIgnoreCase))
                {
                    victimSessionId = a.sessionId;
                    break;
                }
            }

            if (string.IsNullOrEmpty(victimSessionId))
            {
                return;
            }

            StartCoroutine(PostCombat(victimSessionId, kind, true));
        }

        // JsonUtility writes these via reflection; suppress "never assigned" noise.
#pragma warning disable 0649
        [Serializable]
        private sealed class BoundBdEvent
        {
            public EventInfo Event;
            public Delegate Handler;
        }

        [Serializable]
        private sealed class ActiveAircraftResponse
        {
            public bool ok;
            public ActiveAircraftEntry[] aircraft;
        }

        [Serializable]
        private sealed class ActiveAircraftEntry
        {
            public string sessionId;
            public string pilotName;
            public string callsign;
            public string craftName;
            public string bodyName;
            public double lat;
            public double lon;
            public double aslAlt;
            public bool smoothedPositionValid;
            public double smoothedLat;
            public double smoothedLon;
            public double smoothedAslAlt;
        }

        [Serializable]
        private sealed class DragonRadarEnvelope
        {
            public bool ok;
            public DragonRadarState state;
        }

        [Serializable]
        private sealed class DragonRadarCrewReviveOffer
        {
            public string offeredAt;
            public string targetSessionId;
            public string consumedAt;
        }

        [Serializable]
        private sealed class DragonRadarState
        {
            public string gameId;
            public string bodyName;
            public DragonBallState[] balls;
            public DragonRadarCrewReviveOffer crewReviveOffer;
        }

        [Serializable]
        private sealed class DragonBallState
        {
            public string id;
            public string bodyName;
            public double lat;
            public double lon;
            public double aslAlt;
            public string carrierSessionId;
            public string collectedBySessionId;
        }
#pragma warning restore 0649
    }
}
