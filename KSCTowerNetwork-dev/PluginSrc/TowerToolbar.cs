using KSP.UI.Screens;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Tiny ApplicationLauncher stub: gates on tower login, then shows/hides the
    /// <see cref="TowerRadioGui"/> radio panel. All UI lives in <see cref="TowerRadioGui"/>;
    /// "minimize" on the radio just hides it without tearing down audio or the bridge.
    /// </summary>
    /// <remarks>
    /// Two <c>[KSPAddon]</c> entry points (this one for in-game scenes, plus
    /// <see cref="TowerToolbarMainMenu"/> for the main menu) so the radio launcher
    /// button appears on the very first screen — same place stock and
    /// JustReadTheInstructions show their toolbar buttons — letting the user log in
    /// to the tower service before loading a save instead of waiting for KSC/Flight.
    /// <c>KSPAddon</c> is <c>AllowMultiple=false</c>, so a sibling subclass is the
    /// idiomatic way to opt in to a second startup scene without duplicating logic.
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.FlightAndKSC, false)]
    public class TowerToolbar : MonoBehaviour
    {
        private const string IconPath = "KSCTowerNetwork/Icons/toolbar";

        private ApplicationLauncherButton _toolbarButton;
        private bool _toolbarStateSync;

        // Icons are static so they're built exactly once per game session and shared
        // across every TowerToolbar instance (FlightAndKSC + MainMenu subclass + each
        // scene reinstantiation in between). Texture2D objects allocated with `new`
        // are not GC'd by Unity and would otherwise leak ~6 KB of GPU memory per
        // scene transition. The textures are deterministic, so reusing the same
        // reference across instances is always correct.
        private static Texture2D s_iconIdle;
        private static Texture2D s_iconHot;

        private bool _pttHookInstalled;
        private bool _pttHotShown;

        private void Start()
        {
            TowerModSettings.EnsureLoaded();
            TowerVoicePlayback.EnsureExists();
            TowerMicMeter.EnsureExists();
            // Spin up the SFX singleton early so its OnEnable subscribes to the PTT bus
            // before the player can press the very first PTT — otherwise the first release
            // would happen with no listener attached and skip its squelch / beep tail.
            TowerSfx.EnsureExists();
            TowerRadioGui.EnsureExists();
            TowerTrafficRadarGui.EnsureExists();
            HookRadioCallbacks();

            GameEvents.onGUIApplicationLauncherReady.Add(OnAppLauncherReady);
            GameEvents.onGUIApplicationLauncherDestroyed.Add(OnAppLauncherDestroyed);
        }

        private void OnDestroy()
        {
            GameEvents.onGUIApplicationLauncherReady.Remove(OnAppLauncherReady);
            GameEvents.onGUIApplicationLauncherDestroyed.Remove(OnAppLauncherDestroyed);
            UnhookRadioCallbacks();
            UnhookPttBus();
            RemoveToolbarButton();
        }

        private void HookRadioCallbacks()
        {
            var radio = TowerRadioGui.Instance;
            if (radio == null)
            {
                return;
            }

            radio.OnRequestLogout = HandleRadioLogout;
            radio.OnRequestMinimize = SyncToolbarOff;
        }

        private void UnhookRadioCallbacks()
        {
            var radio = TowerRadioGui.Instance;
            if (radio == null)
            {
                return;
            }

            radio.OnRequestLogout = null;
            radio.OnRequestMinimize = null;
        }

        private void OnAppLauncherReady()
        {
            if (_toolbarButton != null || ApplicationLauncher.Instance == null)
            {
                return;
            }

            // Build (or reuse) both palette variants up front so the PTT-hot swap is
            // an instant texture pointer change rather than a per-edge allocation.
            // GameDatabase only feeds the idle texture; the "hot" red variant is always
            // procedural because shipping two PNGs in GameData would (a) double the
            // localizer's scan cost and (b) defeat any future skin overrides.
            // Unity-null check (==) covers both never-built and destroyed-by-Unity
            // cases; the latter shouldn't happen since we never call Destroy on these
            // textures, but the check is cheap and survives unforeseen lifetimes.
            if (s_iconIdle == null)
            {
                s_iconIdle = GameDatabase.Instance.GetTexture(IconPath, false) ?? BuildRadarIcon(hot: false);
            }
            if (s_iconHot == null)
            {
                s_iconHot = BuildRadarIcon(hot: true);
            }

            _pttHotShown = false;
            _toolbarButton = ApplicationLauncher.Instance.AddModApplication(
                onTrue: ShowRadio,
                onFalse: HideRadio,
                onHover: null,
                onHoverOut: null,
                onEnable: null,
                onDisable: null,
                visibleInScenes: ApplicationLauncher.AppScenes.FLIGHT
                                 | ApplicationLauncher.AppScenes.SPACECENTER
                                 | ApplicationLauncher.AppScenes.MAINMENU,
                texture: s_iconIdle
            );

            HookPttBus();
            // Re-sync immediately in case the bus was already open when we attached
            // (e.g. PTT held down across a scene change that destroyed the launcher).
            ApplyPttIcon(TowerPttBus.IsAnySourceOpen);
        }

        private void OnAppLauncherDestroyed()
        {
            RemoveToolbarButton();
        }

        private void RemoveToolbarButton()
        {
            UnhookPttBus();

            if (ApplicationLauncher.Instance != null)
            {
                if (_toolbarButton != null)
                {
                    ApplicationLauncher.Instance.RemoveModApplication(_toolbarButton);
                }
            }

            _toolbarButton = null;
            _pttHotShown = false;
        }

        private void HookPttBus()
        {
            if (_pttHookInstalled)
            {
                return;
            }

            TowerPttBus.PttStateChanged += OnPttStateChanged;
            _pttHookInstalled = true;
        }

        private void UnhookPttBus()
        {
            if (!_pttHookInstalled)
            {
                return;
            }

            TowerPttBus.PttStateChanged -= OnPttStateChanged;
            _pttHookInstalled = false;
        }

        private void OnPttStateChanged(bool open)
        {
            // Bus contract guarantees main-thread invocation, so SetTexture is safe here.
            ApplyPttIcon(open);
        }

        private void ApplyPttIcon(bool hot)
        {
            if (_toolbarButton == null)
            {
                return;
            }

            if (hot == _pttHotShown)
            {
                return;
            }

            var tex = hot ? s_iconHot : s_iconIdle;
            if (tex == null)
            {
                return;
            }

            try
            {
                _toolbarButton.SetTexture(tex);
                _pttHotShown = hot;
            }
            catch (System.Exception e)
            {
                // Don't let a broken launcher button take down the PTT path; just stop trying.
                Debug.LogWarning("[KSCTowerNetwork] Toolbar SetTexture failed: " + e.Message);
            }
        }

        private void ShowRadio()
        {
            if (_toolbarStateSync)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            if (!TowerModSettings.SkipTowerLogin && string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                // Captured via the running MonoBehaviour, with a Unity-null guard so a scene change between
                // Prompt() and the login response does not invoke methods on a destroyed component.
                var self = this;
                TowerLoginGui.Prompt(
                    () =>
                    {
                        // Allow the radio panel to open from the main menu too — the user
                        // logs in there so the connection is hot before they enter a save.
                        // HighLogic.LoadedSceneIsGame is false on MAINMENU/SETTINGS/CREDITS,
                        // so we explicitly admit MAINMENU as a valid post-login surface.
                        if (self == null
                            || (!HighLogic.LoadedSceneIsGame
                                && HighLogic.LoadedScene != GameScenes.MAINMENU))
                        {
                            return;
                        }

                        self.OpenRadioPanel();
                    },
                    () =>
                    {
                        if (self == null)
                        {
                            return;
                        }

                        self.SyncToolbarOff();
                    });
                return;
            }

            OpenRadioPanel();
        }

        private void OpenRadioPanel()
        {
            TowerRadioGui.EnsureExists();
            HookRadioCallbacks();
            var radio = TowerRadioGui.Instance;
            if (radio == null)
            {
                return;
            }

            radio.Visible = true;
        }

        private void HideRadio()
        {
            if (_toolbarStateSync)
            {
                return;
            }

            var radio = TowerRadioGui.Instance;
            if (radio != null)
            {
                radio.Visible = false;
            }
        }

        /// <summary>Called from the radio panel's minimize/logout flows so we don't recurse into HideRadio.</summary>
        private void SyncToolbarOff()
        {
            if (_toolbarButton == null)
            {
                return;
            }

            _toolbarStateSync = true;
            try
            {
                _toolbarButton.SetFalse(false);
            }
            finally
            {
                _toolbarStateSync = false;
            }
        }

        private void HandleRadioLogout()
        {
            if (TowerModSettings.SkipTowerLogin)
            {
                return;
            }

            TowerModSettings.ClearTowerAuth();
            var radio = TowerRadioGui.Instance;
            if (radio != null)
            {
                radio.Visible = false;
                radio.RequestPttKeySuppressUntilRelease();
            }

            SyncToolbarOff();
        }

        /// <summary>
        /// Procedural toolbar icon — an amber-on-dark ATC radar scope that mirrors the
        /// web app's <c>brand-mark.svg</c>: range rings, faint crosshairs, a 90° sweep
        /// wedge through the top with a bright leading arm, three blip dots and a
        /// center pip. When <paramref name="hot"/> is true, the accent palette is
        /// shifted to red so the launcher button signals an open mic at a glance.
        /// </summary>
        private static Texture2D BuildRadarIcon(bool hot)
        {
            const int size = 38;
            const float cx = 18.5f;
            const float cy = 18.5f;
            const float scopeR = 14f;
            const float midR = 8.5f;
            const float innerR = 4.5f;

            var tex = new Texture2D(size, size, TextureFormat.ARGB32, false);
            tex.filterMode = FilterMode.Bilinear;

            // Palette mirrors brand-mark.svg (amber on dark amber). The hot palette swaps
            // amber for the same red that TowerRadioGui uses for the open-mic indicator
            // so the toolbar reads as a continuation of that signal, not a new color.
            var bgInner = hot ? new Color32(48, 14, 14, 255) : new Color32(42, 28, 13, 255);
            var bgOuter = hot ? new Color32(70, 22, 22, 255) : new Color32(61, 42, 20, 255);
            var accent = hot ? new Color32(255, 110, 110, 255) : new Color32(255, 184, 77, 255);
            var bright = hot ? new Color32(255, 170, 170, 255) : new Color32(255, 208, 122, 255);
            var faint = hot ? new Color32(255, 110, 110, 90) : new Color32(255, 184, 77, 90);
            var verFaint = hot ? new Color32(255, 110, 110, 70) : new Color32(255, 184, 77, 70);
            var transparent = new Color32(0, 0, 0, 0);

            // Diagonal background gradient + rounded-corner mask.
            const int corner = 5;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    if (IsOutsideRoundedRect(x, y, size, corner))
                    {
                        tex.SetPixel(x, y, transparent);
                        continue;
                    }

                    var t = (x + y) / (2f * (size - 1));
                    tex.SetPixel(x, y, Color32.Lerp(bgInner, bgOuter, t));
                }
            }

            // Faint crosshairs spanning the full diameter (drawn before the rings so the
            // rings overlay them, just like the SVG layer order).
            for (var x = 4; x < size - 4; x++)
            {
                BlendPixel(tex, x, Mathf.RoundToInt(cy), verFaint);
            }
            for (var y = 4; y < size - 4; y++)
            {
                BlendPixel(tex, Mathf.RoundToInt(cx), y, verFaint);
            }

            // Concentric range rings.
            DrawCircle(tex, cx, cy, innerR, faint);
            DrawCircle(tex, cx, cy, midR, faint);

            // Sweep wedge: pixels inside the scope between bearings 300° and 30°
            // (i.e. the upper-right quadrant rotated CCW by 30°). Opacity ramps from
            // 0 at the trailing edge to ~0.6 at the leading edge — same fade direction
            // as the SVG's userSpace linearGradient.
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    var dx = x + 0.5f - cx;
                    var dy = cy - (y + 0.5f);
                    var r = Mathf.Sqrt(dx * dx + dy * dy);
                    if (r >= scopeR - 0.5f) continue;

                    // Bearing: 0° straight up, increasing clockwise.
                    var bearing = Mathf.Atan2(dx, dy) * Mathf.Rad2Deg;
                    if (bearing < 0) bearing += 360f;

                    float wedgeT;
                    if (bearing >= 300f && bearing <= 360f)
                    {
                        wedgeT = (bearing - 300f) / 90f;
                    }
                    else if (bearing >= 0f && bearing <= 30f)
                    {
                        wedgeT = (60f + bearing) / 90f;
                    }
                    else
                    {
                        continue;
                    }

                    var alpha = Mathf.Lerp(0f, 0.55f, wedgeT);
                    var sweep = new Color32(accent.r, accent.g, accent.b, (byte)Mathf.RoundToInt(alpha * 255f));
                    BlendPixel(tex, x, y, sweep);
                }
            }

            // Outer scope ring (drawn last so it cleanly outlines the wedge edge).
            DrawCircle(tex, cx, cy, scopeR, bright);
            DrawCircle(tex, cx, cy, scopeR - 1f, bright);

            // Sweep arm at the leading edge (bearing 30°): from center to the rim.
            var armEndX = cx + Mathf.Sin(30f * Mathf.Deg2Rad) * (scopeR - 1.5f);
            var armEndY = cy - Mathf.Cos(30f * Mathf.Deg2Rad) * (scopeR - 1.5f);
            DrawThickLine(tex, cx, cy, armEndX, armEndY, bright);

            // Aircraft blips (positions ratioed from the 64-unit SVG coords).
            DrawBlip(tex, 25.7f, 22.9f, bright, 1.4f);
            DrawBlip(tex, 17.2f, 23.9f, bright, 1.1f);
            DrawBlip(tex, 8.5f, 22.8f, faint, 1.0f);

            // Center pip (radar origin).
            DrawBlip(tex, cx, cy, bright, 1.3f);

            tex.Apply(false, true);
            return tex;
        }

        private static bool IsOutsideRoundedRect(int x, int y, int size, int corner)
        {
            // Each of the four corners is masked by a quarter-circle of radius 'corner'.
            int cx, cy;
            if (x < corner && y < corner) { cx = corner; cy = corner; }
            else if (x >= size - corner && y < corner) { cx = size - 1 - corner; cy = corner; }
            else if (x < corner && y >= size - corner) { cx = corner; cy = size - 1 - corner; }
            else if (x >= size - corner && y >= size - corner) { cx = size - 1 - corner; cy = size - 1 - corner; }
            else return false;

            var dx = x - cx;
            var dy = y - cy;
            return dx * dx + dy * dy > corner * corner;
        }

        private static void BlendPixel(Texture2D tex, int x, int y, Color32 over)
        {
            if (x < 0 || y < 0 || x >= tex.width || y >= tex.height) return;
            if (over.a == 0) return;
            if (over.a == 255) { tex.SetPixel(x, y, over); return; }

            var under = tex.GetPixel(x, y);
            var a = over.a / 255f;
            var blended = new Color(
                under.r * (1f - a) + over.r / 255f * a,
                under.g * (1f - a) + over.g / 255f * a,
                under.b * (1f - a) + over.b / 255f * a,
                Mathf.Max(under.a, a));
            tex.SetPixel(x, y, blended);
        }

        private static void DrawCircle(Texture2D tex, float cx, float cy, float r, Color32 color)
        {
            // 1-pixel-wide ring via distance band; antialiased by alpha falloff so the
            // 38-px scope reads as a smooth circle instead of a jagged Bresenham one.
            var minX = Mathf.Max(0, Mathf.FloorToInt(cx - r - 1f));
            var maxX = Mathf.Min(tex.width - 1, Mathf.CeilToInt(cx + r + 1f));
            var minY = Mathf.Max(0, Mathf.FloorToInt(cy - r - 1f));
            var maxY = Mathf.Min(tex.height - 1, Mathf.CeilToInt(cy + r + 1f));

            for (var y = minY; y <= maxY; y++)
            {
                for (var x = minX; x <= maxX; x++)
                {
                    var dx = x + 0.5f - cx;
                    var dy = y + 0.5f - cy;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    var diff = Mathf.Abs(d - r);
                    if (diff > 1f) continue;
                    var coverage = 1f - diff;
                    var c = new Color32(color.r, color.g, color.b, (byte)Mathf.RoundToInt(color.a * coverage));
                    BlendPixel(tex, x, y, c);
                }
            }
        }

        private static void DrawThickLine(Texture2D tex, float x0, float y0, float x1, float y1, Color32 color)
        {
            // Distance-to-segment AA; ~1.6 px wide to match the SVG arm.
            const float halfWidth = 0.9f;
            var minX = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(x0, x1) - halfWidth - 1f));
            var maxX = Mathf.Min(tex.width - 1, Mathf.CeilToInt(Mathf.Max(x0, x1) + halfWidth + 1f));
            var minY = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(y0, y1) - halfWidth - 1f));
            var maxY = Mathf.Min(tex.height - 1, Mathf.CeilToInt(Mathf.Max(y0, y1) + halfWidth + 1f));

            var vx = x1 - x0;
            var vy = y1 - y0;
            var lenSq = vx * vx + vy * vy;

            for (var y = minY; y <= maxY; y++)
            {
                for (var x = minX; x <= maxX; x++)
                {
                    var px = x + 0.5f - x0;
                    var py = y + 0.5f - y0;
                    var t = Mathf.Clamp01((px * vx + py * vy) / lenSq);
                    var dx = px - vx * t;
                    var dy = py - vy * t;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d > halfWidth + 0.5f) continue;
                    var coverage = Mathf.Clamp01(halfWidth + 0.5f - d);
                    var c = new Color32(color.r, color.g, color.b, (byte)Mathf.RoundToInt(color.a * coverage));
                    BlendPixel(tex, x, y, c);
                }
            }
        }

        private static void DrawBlip(Texture2D tex, float cx, float cy, Color32 color, float r)
        {
            var minX = Mathf.Max(0, Mathf.FloorToInt(cx - r - 1f));
            var maxX = Mathf.Min(tex.width - 1, Mathf.CeilToInt(cx + r + 1f));
            var minY = Mathf.Max(0, Mathf.FloorToInt(cy - r - 1f));
            var maxY = Mathf.Min(tex.height - 1, Mathf.CeilToInt(cy + r + 1f));

            for (var y = minY; y <= maxY; y++)
            {
                for (var x = minX; x <= maxX; x++)
                {
                    var dx = x + 0.5f - cx;
                    var dy = y + 0.5f - cy;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d > r + 0.5f) continue;
                    var coverage = Mathf.Clamp01(r + 0.5f - d);
                    var c = new Color32(color.r, color.g, color.b, (byte)Mathf.RoundToInt(color.a * coverage));
                    BlendPixel(tex, x, y, c);
                }
            }
        }
    }

    /// <summary>
    /// Main-menu entry point for the launcher buttons. Inherits all behaviour from
    /// <see cref="TowerToolbar"/>; the only reason this type exists is that
    /// <c>[KSPAddon]</c> is <c>AllowMultiple=false</c>, so we need a second class to
    /// register a second startup scene. Without this, the KSCT button would
    /// only appear after the user loads a save (Space Center / Flight) — but the user
    /// wants to be logged into the tower service before that, on the first screen
    /// (same surface where stock and JustReadTheInstructions show their buttons).
    /// </summary>
    [KSPAddon(KSPAddon.Startup.MainMenu, false)]
    public sealed class TowerToolbarMainMenu : TowerToolbar
    {
    }
}
