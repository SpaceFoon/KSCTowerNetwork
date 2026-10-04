using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// In-game PPI traffic scope: other room pilots within a fixed slant range (tower-style
    /// blips). Separate from <see cref="TowerDragonRadarGui"/> (Dragon Ball hunt). Polls the same
    /// active-aircraft feed as the tower wall; optional annunciator on the radio title bar when
    /// a new contact enters range while this window is closed.
    /// </summary>
    public sealed class TowerTrafficRadarGui : MonoBehaviour
    {
        private static TowerTrafficRadarGui _instance;

        public static TowerTrafficRadarGui Instance
        {
            get { return _instance; }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerTrafficRadarGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerTrafficRadarGui>();
        }

        private const float PanelWidth = 440f;
        private const float PanelHeight = 520f;
        private const float RadarSize = 320f;
        private const float PollIntervalVisibleSeconds = 2f;
        private const float PollIntervalHiddenSeconds = 4f;
        private const float SweepDegPerSecond = 90f;

        /// <summary>Max slant range (km) — blips only; ring scale matches this cap.</summary>
        private const float PlayerRangeKm = 25f;

        private const int RadarFaceTextureVersion = 1;

        private bool _visible;
        private Rect _windowRect = new Rect(520f, 100f, PanelWidth, PanelHeight);
        private int _windowId;

        private bool _started;
        private string _statusLine = "Standby.";
        private float _sweepDeg;

        private readonly List<ActiveAircraftEntry> _aircraft = new List<ActiveAircraftEntry>(32);
        private readonly HashSet<string> _inRangeSessionIds = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> _previousInRangeSessionIds = new HashSet<string>(StringComparer.Ordinal);
        private bool _blipAnnunciatorPrimed;

        private string _selectedSessionId = string.Empty;
        private string _selectedSessionCallsign = string.Empty;
        private string _selectedSessionPilot = string.Empty;

        private Texture2D _texRadarFace;
        private int _radarFaceTextureVersion;
        private Texture2D _texSweep;
        private Texture2D _texBlipPlayer;
        private Texture2D _texMarkerEdge;

        public Action OnRequestMinimize;

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
                    TowerRadioGui.NotifyTrafficRadarRead();
                    _statusLine = "Traffic scope online.";
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
            StartCoroutine(PollLoop());
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        private IEnumerator PollLoop()
        {
            yield return new WaitForSeconds(0.5f);
            while (true)
            {
                var wait = _visible ? PollIntervalVisibleSeconds : PollIntervalHiddenSeconds;
                yield return StartCoroutine(FetchActiveAircraft());
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

            if (TowerSkin.DrawTitleBar("TRAFFIC  ·  25 km", true))
            {
                Visible = false;
                if (OnRequestMinimize != null)
                {
                    OnRequestMinimize();
                }
            }

            GUILayout.BeginHorizontal();
            var sid = (TowerModSettings.SessionId ?? string.Empty).Trim();
            GUILayout.Label("Room: " + (sid.Length > 0 ? sid : "—"), TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("REFRESH", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(22f)))
            {
                StartCoroutine(FetchActiveAircraft());
            }
            GUILayout.EndHorizontal();

            GUILayout.Space(4f);

            var radarRect = GUILayoutUtility.GetRect(RadarSize, RadarSize, GUILayout.ExpandWidth(false));
            radarRect.x = Mathf.Round((PanelWidth - radarRect.width) * 0.5f);
            radarRect.y = Mathf.Round(radarRect.y);
            DrawRadarSurface(radarRect);

            GUILayout.Space(6f);
            DrawSelectionStrip();
            GUILayout.Space(4f);
            GUILayout.Label(_statusLine, TowerSkin.Status);

            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 36f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
        }

        private void DrawSelectionStrip()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            if (string.IsNullOrEmpty(_selectedSessionId))
            {
                GUILayout.Label("Click a blip to tag a contact (display only).", TowerSkin.BodyMuted);
            }
            else
            {
                GUILayout.Label(
                    "Selected: "
                    + TrimForHud(_selectedSessionCallsign, 22)
                    + "  (" + TrimForHud(_selectedSessionPilot, 20) + ")",
                    TowerSkin.Body);
                GUILayout.BeginHorizontal();
                if (GUILayout.Button("CLEAR", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f)))
                {
                    _selectedSessionId = string.Empty;
                    _selectedSessionCallsign = string.Empty;
                    _selectedSessionPilot = string.Empty;
                }
                GUILayout.EndHorizontal();
            }
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
            DrawTrafficBlips(body, refPos, refLat, refLon, center, radius);
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
            var ringRgb = new Color(0f, 1f, 102f / 255f, 0.38f);
            DrawRing(center, radius * 0.25f, ringRgb);
            DrawRing(center, radius * 0.50f, ringRgb);
            DrawRing(center, radius * 0.75f, ringRgb);
            DrawRing(center, radius, ringRgb);
            DrawTextAt(center.x - 10f, center.y - radius - 14f, "N");
            DrawTextAt(center.x + radius + 4f, center.y - 8f, "E");
            DrawTextAt(center.x - 8f, center.y + radius + 2f, "S");
            DrawTextAt(center.x - radius - 12f, center.y - 8f, "W");
            DrawTextAt(center.x - 28f, center.y + radius - 36f, "25 km");
        }

        private void DrawTrafficBlips(
            CelestialBody body,
            Vector3d refPos,
            double refLat,
            double refLon,
            Vector2 center,
            float radius)
        {
            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
            for (var i = 0; i < _aircraft.Count; i++)
            {
                var a = _aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }
                if (own.Length > 0 && string.Equals(a.sessionId, own, StringComparison.Ordinal))
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
                if (distKm > PlayerRangeKm)
                {
                    continue;
                }

                var brg = BearingDeg(refLat, refLon, lat, lon);
                var rr = (float)Math.Min(1d, distKm / PlayerRangeKm);
                var blipPos = PolarToScreen(center, radius * rr, brg);
                DrawBlip(_texBlipPlayer, blipPos, 7f);
                var cs = SafeCallsign(a);
                DrawTextAt(blipPos.x + 5f, blipPos.y - 8f, TrimForHud(cs, 10));
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

            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
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
                if (own.Length > 0 && string.Equals(a.sessionId, own, StringComparison.Ordinal))
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
                if (distKm > PlayerRangeKm)
                {
                    continue;
                }

                var brg = BearingDeg(refLat, refLon, lat, lon);
                var rr = (float)Math.Min(1d, distKm / PlayerRangeKm);
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
                _statusLine = "Selected " + TrimForHud(_selectedSessionCallsign, 14) + ".";
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
            GUI.Label(new Rect(x, y, 120f, 16f), text, TowerSkin.BodyMuted);
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
                    AfterAircraftSnapshot();
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
                    AfterAircraftSnapshot();
                    yield break;
                }
                ApplyActiveAircraftSnapshot(txt);
                AfterAircraftSnapshot();
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

        private void AfterAircraftSnapshot()
        {
            RebuildInRangeSet();
            EvaluateBlipAnnunciator();
        }

        private void RebuildInRangeSet()
        {
            _inRangeSessionIds.Clear();
            CelestialBody body;
            Vector3d refPos;
            double refLat;
            double refLon;
            if (!TryGetReference(out body, out refPos, out refLat, out refLon))
            {
                return;
            }

            var own = (TowerModSettings.SessionId ?? string.Empty).Trim();
            for (var i = 0; i < _aircraft.Count; i++)
            {
                var a = _aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }
                if (own.Length > 0 && string.Equals(a.sessionId, own, StringComparison.Ordinal))
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
                if (distKm <= PlayerRangeKm)
                {
                    _inRangeSessionIds.Add(a.sessionId);
                }
            }
        }

        private void EvaluateBlipAnnunciator()
        {
            if (!_blipAnnunciatorPrimed)
            {
                _previousInRangeSessionIds.Clear();
                foreach (var id in _inRangeSessionIds)
                {
                    _previousInRangeSessionIds.Add(id);
                }
                _blipAnnunciatorPrimed = true;
                return;
            }

            var anyNew = false;
            foreach (var id in _inRangeSessionIds)
            {
                if (!_previousInRangeSessionIds.Contains(id))
                {
                    anyNew = true;
                    break;
                }
            }

            _previousInRangeSessionIds.Clear();
            foreach (var id in _inRangeSessionIds)
            {
                _previousInRangeSessionIds.Add(id);
            }

            if (!anyNew || _visible)
            {
                return;
            }

            TowerRadioGui.NotifyTrafficRadarNearby();
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
                return req.isHttpError;
            }
            if (code < 200 || code > 299)
            {
                return true;
            }
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
                    oneLine = oneLine.Substring(0, 220) + "\u2026";
                }
                if (!string.IsNullOrEmpty(oneLine))
                {
                    bits.Add(oneLine);
                }
            }
            return string.Join(" · ", bits.ToArray());
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
            if (_texSweep == null)
            {
                _texSweep = SolidTex(new Color32(120, 255, 170, 180));
            }
            if (_texBlipPlayer == null)
            {
                _texBlipPlayer = SolidTex(new Color32(180, 255, 190, 255));
            }
            if (_texMarkerEdge == null)
            {
                _texMarkerEdge = SolidTex(new Color32(120, 180, 120, 255));
            }
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
                    px[idx] = new Color32(12, g, b, 230);
                }
            }

            t.SetPixels32(px);
            t.Apply(false, true);
            return t;
        }

        private static string TrimForHud(string text, int max)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "\u2014";
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

#pragma warning disable 0649
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
#pragma warning restore 0649
    }
}
