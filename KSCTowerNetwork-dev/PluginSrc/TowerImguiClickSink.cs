using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Extra IMGUI mouse consumption on top of ClickThroughBlocker: CTB locks flight
    /// input from the window rect, but some clicks still reach staging / IVA when they
    /// hit "dead" chrome or when a surface never runs a <c>GUI.Window</c> at all.
    /// </summary>
    internal static class TowerImguiClickSink
    {
        /// <summary>
        /// Call at the end of a <c>GUI.Window</c> / <c>GUILayout.Window</c> callback (local coords).
        /// Uses the event only if no control already claimed <see cref="GUIUtility.hotControl"/>.
        /// Skips <see cref="EventType.ScrollWheel"/> so scroll views keep working.
        /// Does not consume <see cref="EventType.MouseDown"/> — swallowing an unhandled MouseDown
        /// with <c>hotControl == 0</c> breaks <c>GUI.Button</c> / <c>GUILayout.Button</c> for the
        /// same click (the press never reaches the control). Dead-chrome MouseDown bleed-through is
        /// still acceptable; <see cref="TowerClickBlock"/> owns the window rect.
        /// </summary>
        internal static void UseUnhandledMouseInLocalWindow(Rect localFullWindow)
        {
            var e = Event.current;
            if (e == null)
            {
                return;
            }

            switch (e.type)
            {
                case EventType.MouseUp:
                case EventType.MouseDrag:
                case EventType.ContextClick:
                    break;
                default:
                    return;
            }

            if (!localFullWindow.Contains(e.mousePosition))
            {
                return;
            }

            if (GUIUtility.hotControl != 0)
            {
                return;
            }

            e.Use();
        }

        /// <summary>
        /// Screen-space rect (same space as <see cref="Event.mousePosition"/> in IMGUI).
        /// Always consumes matching events — use only where there are no child controls.
        /// </summary>
        internal static void ConsumeMouseInScreenRect(Rect screenRect)
        {
            var e = Event.current;
            if (e == null)
            {
                return;
            }

            switch (e.type)
            {
                case EventType.MouseDown:
                case EventType.MouseUp:
                case EventType.MouseDrag:
                case EventType.ScrollWheel:
                case EventType.ContextClick:
                    break;
                default:
                    return;
            }

            if (!screenRect.Contains(e.mousePosition))
            {
                return;
            }

            e.Use();
        }
    }
}
