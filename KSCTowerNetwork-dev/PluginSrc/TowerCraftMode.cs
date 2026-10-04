using System;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Operational craft category for the in-game tower plugin (rocket / plane / rover).
    /// Used to pick mode-specific checklists (<see cref="TowerChecklistDefaults"/>) and
    /// PTT-release SFX (<see cref="TowerSfx.PlayPttRelease"/>).
    /// </summary>
    public enum CraftMode
    {
        Plane,
        Rocket,
        Rover
    }

    /// <summary>
    /// Single source of truth for "what kind of vehicle is the player flying right now?".
    /// Mirrors the classification in <c>TowerTelemetryPublisher.ComputeCraftMapIcon</c> so
    /// the marker icon, the local checklist fallback and the radio's PTT-release tail all
    /// agree on rocket vs plane vs rover.
    /// </summary>
    /// <remarks>
    /// Detection is intentionally conservative:
    /// <list type="bullet">
    /// <item><c>Plane</c> when <see cref="VesselType"/> is <see cref="VesselType.Plane"/>.</item>
    /// <item><c>Rover</c> when not a Plane, currently landed/splashed, and the vessel has a
    ///   drive wheel module (stock KSP has no <c>Rover</c> vessel type).</item>
    /// <item><c>Rocket</c> in every other case (default — also the value returned when no
    ///   <see cref="FlightGlobals.ActiveVessel"/> exists, e.g. at KSC).</item>
    /// </list>
    /// Callers may either query <see cref="Current"/> at the moment of need or subscribe to
    /// <see cref="OnModeChanged"/> for reactive updates. <see cref="Current"/> caches the last
    /// computed value for <see cref="MinRefreshSeconds"/> so frequent callers (e.g. PTT release)
    /// don't walk the part list on every press.
    /// </remarks>
    public static class TowerCraftMode
    {
        // Half a second is short enough that a player switching from rover to plane at
        // KSC sees the new mode by the time they reach for PTT, and long enough that
        // back-to-back PTT taps don't re-walk the part list.
        private const float MinRefreshSeconds = 0.5f;

        // Default to Plane so the checklist GUI seeded at field-init time (before any
        // vessel exists) shows the existing ATC-style cards rather than a blank slate.
        private static CraftMode _current = CraftMode.Plane;
        private static float _lastRefreshAt = -1000f;
        private static bool _hasEverComputed;

        /// <summary>
        /// Fired on the Unity main thread whenever the cached mode changes (rocket -> plane,
        /// plane -> rover, etc.). NOT fired for the initial seed value.
        /// </summary>
        public static event Action<CraftMode> OnModeChanged;

        /// <summary>
        /// Last computed mode. Triggers a fresh detection when older than
        /// <see cref="MinRefreshSeconds"/>; safe to call from OnGUI / Update hot paths.
        /// </summary>
        public static CraftMode Current
        {
            get
            {
                Refresh(false);
                return _current;
            }
        }

        /// <summary>
        /// Force a fresh detection (or honour the <see cref="MinRefreshSeconds"/> cache when
        /// <paramref name="force"/> is false). Returns the detected mode for convenience.
        /// </summary>
        public static CraftMode Refresh(bool force)
        {
            float now;
            try
            {
                now = Time.unscaledTime;
            }
            catch
            {
                // Time is unavailable in some early-boot frames; treat as "always refresh".
                now = float.MaxValue;
            }

            if (!force && _hasEverComputed && (now - _lastRefreshAt) < MinRefreshSeconds)
            {
                return _current;
            }

            _lastRefreshAt = now;
            _hasEverComputed = true;

            var detected = Detect();
            if (detected == _current)
            {
                return _current;
            }

            var prev = _current;
            _current = detected;
            var handler = OnModeChanged;
            if (handler != null)
            {
                try
                {
                    handler(_current);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning(
                        "[KSCTowerNetwork] CraftMode subscriber threw (" + prev + " -> " + _current + "): " + ex);
                }
            }

            return _current;
        }

        private static CraftMode Detect()
        {
            Vessel v = null;
            try
            {
                if (FlightGlobals.ready)
                {
                    v = FlightGlobals.ActiveVessel;
                }
            }
            catch
            {
                // FlightGlobals can NRE on the very first frame after a scene change; treat as no vessel.
                v = null;
            }

            if (v == null)
            {
                // Outside flight (KSC, tracking station, main menu) — default Plane keeps the
                // standard ATC checklist visible, which is what players expect when they open
                // the radio panel before launch.
                return CraftMode.Plane;
            }

            if (v.vesselType == VesselType.Plane)
            {
                return CraftMode.Plane;
            }

            if (v.LandedOrSplashed && VesselHasDriveWheel(v))
            {
                return CraftMode.Rover;
            }

            return CraftMode.Rocket;
        }

        private static bool VesselHasDriveWheel(Vessel v)
        {
            if (v == null || v.Parts == null)
            {
                return false;
            }

            for (int i = 0; i < v.Parts.Count; i++)
            {
                var p = v.Parts[i];
                if (p == null)
                {
                    continue;
                }

                // ModuleWheel is the stock indicator; KSPWheel adds its own modules but they
                // also register as ModuleWheelBase derivatives so a name match is enough.
                if (p.Modules != null && p.Modules.Contains("ModuleWheel"))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
