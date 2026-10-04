using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Shared IMGUI skin so the ACARS and Checklist windows have the same dark-warm "tower
    /// radio" look as <see cref="TowerRadioGui"/>: dark amber-tinted panel background, amber
    /// titles/labels, inset sub-panels, divider line, and small square icon buttons. Built
    /// lazily the first time any GUI calls <see cref="EnsureBuilt"/> so the textures are
    /// created on the main Unity thread inside an OnGUI pass.
    /// </summary>
    /// <remarks>
    /// Colour palette mirrors the values in <c>TowerRadioGui.EnsureTextures</c> so the three
    /// surfaces really do match (a player can have all three open at once and they read as
    /// one console). If you tweak colours here, eyeball the radio panel afterwards — it still
    /// owns its own textures because it predates this helper and uses 12+ specialised tints
    /// (LEDs, VU meters, power switch) that aren't worth lifting out.
    /// </remarks>
    public static class TowerSkin
    {
        public static GUIStyle Panel;
        public static GUIStyle Title;
        public static GUIStyle Subtitle;
        public static GUIStyle Body;
        public static GUIStyle BodyMuted;
        public static GUIStyle Status;
        public static GUIStyle StatusError;
        public static GUIStyle Button;
        public static GUIStyle ButtonActive;
        public static GUIStyle IconButton;
        public static GUIStyle Inset;
        public static GUIStyle TextField;
        public static GUIStyle TextArea;
        public static GUIStyle Toggle;

        public static Texture2D PanelTex;
        public static Texture2D InsetTex;
        public static Texture2D DividerTex;
        public static Texture2D ButtonTex;
        public static Texture2D ButtonHoverTex;
        public static Texture2D ButtonActiveTex;

        public static readonly Color AmberBright = new Color(1f, 0.78f, 0.32f, 1f);
        public static readonly Color AmberWarm = new Color(0.95f, 0.93f, 0.78f, 1f);
        public static readonly Color AmberDim = new Color(0.85f, 0.83f, 0.7f, 1f);
        public static readonly Color BodyText = new Color(0.92f, 0.9f, 0.82f, 1f);
        public static readonly Color MutedText = new Color(0.75f, 0.7f, 0.55f, 1f);
        public static readonly Color StatusText = new Color(0.8f, 0.78f, 0.62f, 1f);
        public static readonly Color ErrorText = new Color(1f, 0.55f, 0.45f, 1f);

        private static bool _built;

        public static void EnsureBuilt()
        {
            if (_built) return;
            _built = true;

            PanelTex = MakeTex(new Color32(28, 24, 20, 240));
            InsetTex = MakeTex(new Color32(16, 14, 12, 255));
            DividerTex = MakeTex(new Color32(110, 95, 70, 255));
            ButtonTex = MakeTex(new Color32(50, 44, 36, 255));
            ButtonHoverTex = MakeTex(new Color32(70, 60, 46, 255));
            ButtonActiveTex = MakeTex(new Color32(120, 90, 40, 255));

            Panel = new GUIStyle(GUI.skin.box)
            {
                alignment = TextAnchor.UpperLeft,
                padding = new RectOffset(8, 8, 8, 8),
                border = new RectOffset(0, 0, 0, 0),
                normal = { background = PanelTex, textColor = BodyText }
            };

            Title = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 14,
                fontStyle = FontStyle.Bold,
                normal = { textColor = AmberWarm }
            };

            Subtitle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 12,
                fontStyle = FontStyle.Bold,
                normal = { textColor = AmberDim }
            };

            Body = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 12,
                wordWrap = true,
                richText = true,
                normal = { textColor = BodyText }
            };

            BodyMuted = new GUIStyle(Body)
            {
                normal = { textColor = MutedText },
                fontStyle = FontStyle.Italic
            };

            Status = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 11,
                fontStyle = FontStyle.Italic,
                normal = { textColor = StatusText }
            };

            StatusError = new GUIStyle(Status)
            {
                normal = { textColor = ErrorText }
            };

            Button = new GUIStyle(GUI.skin.button)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 12,
                fontStyle = FontStyle.Bold,
                padding = new RectOffset(8, 8, 4, 4),
                border = new RectOffset(2, 2, 2, 2),
                normal = { background = ButtonTex, textColor = AmberWarm },
                hover = { background = ButtonHoverTex, textColor = AmberBright },
                active = { background = ButtonActiveTex, textColor = Color.white },
                focused = { background = ButtonHoverTex, textColor = AmberBright }
            };

            ButtonActive = new GUIStyle(Button)
            {
                normal = { background = ButtonActiveTex, textColor = Color.white },
                hover = { background = ButtonActiveTex, textColor = Color.white },
                focused = { background = ButtonActiveTex, textColor = Color.white }
            };

            IconButton = new GUIStyle(Button)
            {
                fontSize = 14,
                padding = new RectOffset(0, 0, 0, 0),
                alignment = TextAnchor.MiddleCenter
            };

            Inset = new GUIStyle(GUI.skin.box)
            {
                padding = new RectOffset(8, 8, 6, 6),
                border = new RectOffset(2, 2, 2, 2),
                normal = { background = InsetTex, textColor = BodyText }
            };

            TextField = new GUIStyle(GUI.skin.textField)
            {
                fontSize = 12,
                padding = new RectOffset(6, 6, 4, 4),
                normal = { background = InsetTex, textColor = BodyText },
                focused = { background = InsetTex, textColor = Color.white },
                hover = { background = InsetTex, textColor = BodyText }
            };

            TextArea = new GUIStyle(GUI.skin.textArea)
            {
                fontSize = 12,
                wordWrap = true,
                padding = new RectOffset(6, 6, 4, 4),
                normal = { background = InsetTex, textColor = BodyText },
                focused = { background = InsetTex, textColor = Color.white },
                hover = { background = InsetTex, textColor = BodyText }
            };

            Toggle = new GUIStyle(GUI.skin.toggle)
            {
                fontSize = 12,
                normal = { textColor = BodyText },
                onNormal = { textColor = AmberBright },
                hover = { textColor = AmberBright },
                onHover = { textColor = AmberBright }
            };
        }

        /// <summary>
        /// Draw the standard tower title bar: amber title on the left, optional minimize "−"
        /// icon button on the right, divider underneath. Returns true when the minimize was
        /// clicked this frame.
        /// </summary>
        public static bool DrawTitleBar(string title, bool showMinimize)
        {
            EnsureBuilt();
            var clickedMin = false;

            GUILayout.BeginHorizontal();
            GUILayout.Label(title, Title);
            GUILayout.FlexibleSpace();
            if (showMinimize)
            {
                if (GUILayout.Button("\u2013", IconButton, GUILayout.Width(28f), GUILayout.Height(22f)))
                {
                    clickedMin = true;
                }
            }
            GUILayout.EndHorizontal();
            DrawDivider();
            return clickedMin;
        }

        public static void DrawDivider()
        {
            EnsureBuilt();
            var r = GUILayoutUtility.GetRect(1f, 2f, GUILayout.ExpandWidth(true));
            GUI.DrawTexture(r, DividerTex);
            GUILayout.Space(4f);
        }

        private static Texture2D MakeTex(Color32 c)
        {
            var t = new Texture2D(2, 2, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp
            };
            var px = new Color32[4] { c, c, c, c };
            t.SetPixels32(px);
            t.Apply(false, true);
            return t;
        }
    }
}
