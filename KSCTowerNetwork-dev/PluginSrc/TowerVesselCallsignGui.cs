using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// First-time callsign for the active vessel (persisted by <see cref="Vessel.persistentId"/>).
    /// </summary>
    public class TowerVesselCallsignGui : MonoBehaviour
    {
        private static TowerVesselCallsignGui _instance;

        public static bool Visible
        {
            get { return _instance != null && _instance._visible; }
        }

        private bool _visible;
        private Vector2 _scrollPos;
        private uint _vesselPid;
        private string _vesselLabel = "";
        private string _draft = "";
        private string _statusLine = "";
        private int _rerollSalt;
        private GUIStyle _helpWrapStyle;

        private const float CallsignWinW = 460f;
        private const float CallsignWinH = 420f;
        private Rect _windowRect;
        private int _windowId;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(this);
                return;
            }

            _instance = this;
            _windowId = GetInstanceID() ^ 0x56435347;
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerVesselCallsignGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerVesselCallsignGui>();
        }

        /// <summary>Show modal for the given vessel (must be <see cref="FlightGlobals.ActiveVessel"/>).</summary>
        public static void Prompt(Vessel v)
        {
            if (v == null)
            {
                return;
            }

            EnsureExists();
            TowerVesselCallsignStore.EnsureLoaded();
            TowerModSettings.EnsureLoaded();
            _instance._visible = true;
            _instance._scrollPos = Vector2.zero;
            _instance._vesselPid = v.persistentId;
            _instance._vesselLabel = (v.vesselName ?? "").Trim();
            if (_instance._vesselLabel.Length > 80)
            {
                _instance._vesselLabel = _instance._vesselLabel.Substring(0, 80) + "…";
            }

            _instance._rerollSalt = 0;
            _instance._draft = TowerVesselCallsignStore.SuggestRoleplayCallsign(v, 0);
            _instance._statusLine = "";
            _instance._windowRect = new Rect(
                (Screen.width - CallsignWinW) * 0.5f,
                (Screen.height - CallsignWinH) * 0.5f,
                CallsignWinW,
                CallsignWinH);
        }

        private void Close()
        {
            _visible = false;
            _statusLine = "";
        }

        private void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            TowerSkin.EnsureBuilt();

            var maxX = Mathf.Max(0f, Screen.width - CallsignWinW);
            var maxY = Mathf.Max(0f, Screen.height - CallsignWinH);
            _windowRect.x = Mathf.Clamp(_windowRect.x, 0f, maxX);
            _windowRect.y = Mathf.Clamp(_windowRect.y, 0f, maxY);

            _windowRect = TowerClickBlock.GUILayoutWindow(
                _windowId,
                _windowRect,
                DrawCallsignWindow,
                GUIContent.none,
                TowerSkin.Panel);
        }

        private void DrawCallsignWindow(int id)
        {
            GUILayout.BeginVertical();
            GUILayout.Label("Vessel callsign", HighLogic.Skin.label);
            GUILayout.Space(4);
            if (_helpWrapStyle == null)
            {
                _helpWrapStyle = new GUIStyle(HighLogic.Skin.label) { wordWrap = true };
            }

            GUILayout.Label(
                "Tower uses a separate callsign per craft (saved with this ship). Pick something ATC would say on frequency — suggested from your vessel name.",
                _helpWrapStyle,
                GUILayout.MaxWidth(CallsignWinW - 16f));
            GUILayout.Space(6);
            GUILayout.Label("Ship: " + _vesselLabel, HighLogic.Skin.label);
            GUILayout.Space(6);

            _scrollPos = GUILayout.BeginScrollView(
                _scrollPos,
                GUIStyle.none,
                GUI.skin.verticalScrollbar,
                GUILayout.Width(CallsignWinW - 8f),
                GUILayout.Height(CallsignWinH - 150f));

            GUILayout.Label("Callsign for this vessel");
            _draft = GUILayout.TextField(_draft ?? "", 120, GUILayout.MinHeight(24));

            GUILayout.Space(6);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Use account callsign", GUILayout.Height(26)))
            {
                var ac = (TowerModSettings.PilotCallsign ?? string.Empty).Trim();
                if (ac.Length == 0)
                {
                    _statusLine = "Log in (or set account callsign) first.";
                }
                else
                {
                    TowerVesselCallsignStore.SetVesselCallsign(_vesselPid, ac);
                    Close();
                }
            }

            if (GUILayout.Button("Re-roll suggestion", GUILayout.Height(26)))
            {
                var v = FlightGlobals.ActiveVessel;
                if (v != null && v.persistentId == _vesselPid)
                {
                    _rerollSalt++;
                    _draft = TowerVesselCallsignStore.SuggestRoleplayCallsign(v, _rerollSalt);
                    _statusLine = "";
                }
            }

            GUILayout.EndHorizontal();

            GUILayout.EndScrollView();

            if (!string.IsNullOrEmpty(_statusLine))
            {
                GUILayout.Label(_statusLine, HighLogic.Skin.label);
            }

            GUILayout.Space(4);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Save & continue", GUILayout.Height(30)))
            {
                var t = (_draft ?? string.Empty).Trim();
                if (t.Length == 0)
                {
                    _statusLine = "Enter a callsign (or use account / not now).";
                }
                else
                {
                    TowerVesselCallsignStore.SetVesselCallsign(_vesselPid, t);
                    Close();
                }
            }

            if (GUILayout.Button("Not now", GUILayout.Height(30)))
            {
                TowerVesselCallsignWatcher.NotifySkipped(_vesselPid);
                Close();
            }

            GUILayout.EndHorizontal();
            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, CallsignWinW - 8f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, CallsignWinW, CallsignWinH));
        }
    }
}
