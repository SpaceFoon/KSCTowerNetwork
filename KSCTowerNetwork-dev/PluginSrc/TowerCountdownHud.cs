using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// In-flight HUD that mirrors the web app's <c>CountdownPanel</c> for the pilot side:
    /// a full-width, screen-centered band with very large T-minus text while a countdown is active
    /// (reads across the whole display instead of a small draggable window).
    ///
    /// The "request launch" affordance lives in <see cref="TowerRadioGui"/> (REQUEST LAUNCH row).
    ///
    /// Source of truth is <see cref="TowerCountdownState"/>, filled by <see cref="TowerTelemetryPublisher"/>
    /// from the telemetry-POST response.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerCountdownHud : MonoBehaviour
    {
        private const int OverlayDepth = 15000;

        private GUIStyle _bigClockStyle;
        private bool _stylesReady;
        private static Texture2D _white1x1;

        private void OnGUI()
        {
            TowerModSettings.EnsureLoaded();
            if (string.IsNullOrEmpty(TowerModSettings.SessionId))
            {
                return;
            }

            if (!TowerModSettings.SkipTowerLogin && string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                return;
            }

            var active = TowerCountdownState.Active;
            var remaining = TowerCountdownState.SecondsRemaining;
            if (!active || float.IsNaN(remaining) || remaining <= -3f)
            {
                return;
            }

            TowerImguiClickSink.ConsumeMouseInScreenRect(new Rect(0f, 0f, Screen.width, Screen.height));

            if (Event.current.type != EventType.Repaint)
            {
                return;
            }

            EnsureStyles();
            _bigClockStyle.fontSize = Mathf.Clamp(Mathf.RoundToInt(Screen.height * 0.11f), 72, 220);

            string label;
            if (float.IsNaN(remaining))
            {
                label = "—";
            }
            else if (remaining > 0.5f)
            {
                label = "T-" + Mathf.CeilToInt(remaining).ToString("D2");
            }
            else if (remaining > -3f)
            {
                label = "T-00  LIFTOFF";
            }
            else
            {
                label = "—";
            }

            var prevDepth = GUI.depth;
            GUI.depth = OverlayDepth;

            var bandH = Mathf.Clamp(Screen.height * 0.36f, 220f, 560f);
            var band = new Rect(0f, (Screen.height - bandH) * 0.5f, Screen.width, bandH);

            var prev = GUI.color;
            GUI.color = new Color(0.02f, 0.03f, 0.06f, 0.78f);
            GUI.DrawTexture(band, White1x1(), ScaleMode.StretchToFill, true);
            GUI.color = prev;

            GUI.Label(band, label, _bigClockStyle);

            GUI.depth = prevDepth;
        }

        private static Texture2D White1x1()
        {
            if (_white1x1 != null)
            {
                return _white1x1;
            }

            _white1x1 = new Texture2D(1, 1, TextureFormat.RGBA32, false);
            _white1x1.SetPixel(0, 0, Color.white);
            _white1x1.Apply(false, true);
            return _white1x1;
        }

        private void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }

            _stylesReady = true;

            _bigClockStyle = new GUIStyle(GUI.skin.label);
            _bigClockStyle.fontSize = 120;
            _bigClockStyle.alignment = TextAnchor.MiddleCenter;
            _bigClockStyle.fontStyle = FontStyle.Bold;
            _bigClockStyle.wordWrap = false;
            _bigClockStyle.clipping = TextClipping.Overflow;
            _bigClockStyle.normal.textColor = new Color(0.98f, 0.92f, 0.35f, 1f);
        }
    }
}
