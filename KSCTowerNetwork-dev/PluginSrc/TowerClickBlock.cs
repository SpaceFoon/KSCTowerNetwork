using System;
using System.Reflection;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Soft-bind wrapper around <c>ClickThroughFix.ClickThruBlocker</c> (linuxgurugamer's
    /// ClickThroughBlocker). When the mod is installed, our IMGUI windows route their
    /// <c>GUI.Window</c> / <c>GUILayout.Window</c> calls through ClickThruBlocker so a click
    /// on the window doesn't bleed through to the part / staging UI underneath. When it is
    /// not installed, we silently fall back to stock Unity calls — the windows still work,
    /// they're just the usual leaky KSP IMGUI windows.
    /// </summary>
    /// <remarks>
    /// We use runtime reflection (same pattern as the Kerbalism radiation hook in
    /// <c>TowerTelemetryPublisher</c>) instead of a compile-time reference so:
    ///   - the build does not require ClickThroughBlocker.dll on the developer's machine,
    ///   - end users without ClickThroughBlocker still get a working mod (degraded UX only),
    ///   - we can list ClickThroughBlocker as a CKAN <c>recommends</c> rather than a hard
    ///     <c>depends</c> — players already running it (most do) get the safety automatically,
    ///     stripped-down installs still load.
    ///
    /// Method handles are probed lazily on first call and cached. A single failed probe (mod
    /// missing, wrong version, signature mismatch) latches the wrapper into pass-through mode
    /// for the rest of the process so we don't pay reflection cost on every Window call.
    /// </remarks>
    internal static class TowerClickBlock
    {
        private static bool _probed;
        private static MethodInfo _miGuiWindowContent;
        private static MethodInfo _miGuiLayoutWindowContent;
        private static MethodInfo _miGuiLayoutWindowString;
        private static bool _guiLayoutContentPassesEmptyOptions;
        private static bool _guiLayoutStringPassesEmptyOptions;
        private static readonly GUILayoutOption[] EmptyLayoutOptions = new GUILayoutOption[0];

        /// <summary>True once we've successfully bound at least one ClickThruBlocker entry point.</summary>
        public static bool Bound
        {
            get
            {
                EnsureProbed();
                return _miGuiWindowContent != null
                    || _miGuiLayoutWindowContent != null
                    || _miGuiLayoutWindowString != null;
            }
        }

        /// <summary>
        /// Drop-in replacement for <c>GUI.Window(id, rect, func, content, style)</c>.
        /// </summary>
        public static Rect GUIWindow(int id, Rect rect, GUI.WindowFunction func, GUIContent content, GUIStyle style)
        {
            EnsureProbed();
            if (_miGuiWindowContent != null)
            {
                try
                {
                    return (Rect)_miGuiWindowContent.Invoke(null, new object[] { id, rect, func, content, style });
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] ClickThruBlocker.GUIWindow invoke failed, falling back: " + ex.Message);
                    _miGuiWindowContent = null;
                }
            }
            return GUI.Window(id, rect, func, content, style);
        }

        /// <summary>
        /// Drop-in replacement for <c>GUILayout.Window(id, rect, func, content, style)</c>.
        /// </summary>
        public static Rect GUILayoutWindow(int id, Rect rect, GUI.WindowFunction func, GUIContent content, GUIStyle style)
        {
            EnsureProbed();
            if (_miGuiLayoutWindowContent != null)
            {
                try
                {
                    if (_guiLayoutContentPassesEmptyOptions)
                    {
                        return (Rect)_miGuiLayoutWindowContent.Invoke(
                            null,
                            new object[] { id, rect, func, content, style, EmptyLayoutOptions });
                    }

                    return (Rect)_miGuiLayoutWindowContent.Invoke(null, new object[] { id, rect, func, content, style });
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] ClickThruBlocker.GUILayoutWindow(content) invoke failed, falling back: " + ex.Message);
                    _miGuiLayoutWindowContent = null;
                }
            }
            return GUILayout.Window(id, rect, func, content, style);
        }

        /// <summary>
        /// Drop-in replacement for <c>GUILayout.Window(id, rect, func, title, style)</c>.
        /// </summary>
        public static Rect GUILayoutWindow(int id, Rect rect, GUI.WindowFunction func, string title, GUIStyle style)
        {
            EnsureProbed();
            if (_miGuiLayoutWindowString != null)
            {
                try
                {
                    if (_guiLayoutStringPassesEmptyOptions)
                    {
                        return (Rect)_miGuiLayoutWindowString.Invoke(
                            null,
                            new object[] { id, rect, func, title, style, EmptyLayoutOptions });
                    }

                    return (Rect)_miGuiLayoutWindowString.Invoke(null, new object[] { id, rect, func, title, style });
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] ClickThruBlocker.GUILayoutWindow(string) invoke failed, falling back: " + ex.Message);
                    _miGuiLayoutWindowString = null;
                }
            }
            return GUILayout.Window(id, rect, func, title, style);
        }

        private static void EnsureProbed()
        {
            if (_probed)
            {
                return;
            }
            _probed = true;

            try
            {
                Type ctbType = null;
                var assemblies = AppDomain.CurrentDomain.GetAssemblies();
                for (int i = 0; i < assemblies.Length; i++)
                {
                    var asm = assemblies[i];
                    if (asm == null)
                    {
                        continue;
                    }

                    var name = asm.GetName().Name;
                    if (string.IsNullOrEmpty(name) || name.IndexOf("ClickThroughBlocker", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    ctbType = asm.GetType("ClickThroughFix.ClickThruBlocker", false);
                    if (ctbType != null)
                    {
                        break;
                    }
                }

                if (ctbType == null)
                {
                    return;
                }

                _miGuiWindowContent = ctbType.GetMethod(
                    "GUIWindow",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(int), typeof(Rect), typeof(GUI.WindowFunction), typeof(GUIContent), typeof(GUIStyle) },
                    null);

                // Current linuxgurugamer builds use GUILayoutOption[] (params) on these overloads; older builds had 5 params only.
                _miGuiLayoutWindowContent = ctbType.GetMethod(
                    "GUILayoutWindow",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(int), typeof(Rect), typeof(GUI.WindowFunction), typeof(GUIContent), typeof(GUIStyle), typeof(GUILayoutOption[]) },
                    null);
                if (_miGuiLayoutWindowContent != null)
                {
                    _guiLayoutContentPassesEmptyOptions = true;
                }
                else
                {
                    _miGuiLayoutWindowContent = ctbType.GetMethod(
                        "GUILayoutWindow",
                        BindingFlags.Public | BindingFlags.Static,
                        null,
                        new[] { typeof(int), typeof(Rect), typeof(GUI.WindowFunction), typeof(GUIContent), typeof(GUIStyle) },
                        null);
                    _guiLayoutContentPassesEmptyOptions = false;
                }

                _miGuiLayoutWindowString = ctbType.GetMethod(
                    "GUILayoutWindow",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(int), typeof(Rect), typeof(GUI.WindowFunction), typeof(string), typeof(GUIStyle), typeof(GUILayoutOption[]) },
                    null);
                if (_miGuiLayoutWindowString != null)
                {
                    _guiLayoutStringPassesEmptyOptions = true;
                }
                else
                {
                    _miGuiLayoutWindowString = ctbType.GetMethod(
                        "GUILayoutWindow",
                        BindingFlags.Public | BindingFlags.Static,
                        null,
                        new[] { typeof(int), typeof(Rect), typeof(GUI.WindowFunction), typeof(string), typeof(GUIStyle) },
                        null);
                    _guiLayoutStringPassesEmptyOptions = false;
                }

                Debug.Log("[KSCTowerNetwork] ClickThroughBlocker bound: GUIWindow="
                    + (_miGuiWindowContent != null)
                    + " GUILayoutWindow(content)=" + (_miGuiLayoutWindowContent != null)
                    + " GUILayoutWindow(string)=" + (_miGuiLayoutWindowString != null));
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] ClickThroughBlocker probe failed (falling back to stock GUI windows): " + ex.Message);
            }
        }
    }
}
