using System.Collections.Generic;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// When the telemetry beacon is on and the active vessel has no saved callsign, opens
    /// <see cref="TowerVesselCallsignGui"/> once so the player can set a per-craft name before tower sees traffic.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerVesselCallsignWatcher : MonoBehaviour
    {
        private static readonly HashSet<uint> SessionSkip = new HashSet<uint>();

        private void Awake()
        {
            GameEvents.onGameSceneLoadRequested.Add(OnSceneLoad);
        }

        private void OnDestroy()
        {
            GameEvents.onGameSceneLoadRequested.Remove(OnSceneLoad);
        }

        private static void OnSceneLoad(GameScenes _)
        {
            SessionSkip.Clear();
        }

        public static void NotifySkipped(uint persistentId)
        {
            SessionSkip.Add(persistentId);
        }

        private void Update()
        {
            if (!FlightGlobals.ready || FlightGlobals.ActiveVessel == null)
            {
                return;
            }

            if (TowerModSettings.StreamAsTower)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            if (!TowerModSettings.BeaconActive)
            {
                return;
            }

            var v = FlightGlobals.ActiveVessel;
            var pid = v.persistentId;
            if (TowerVesselCallsignStore.IsConfigured(pid))
            {
                return;
            }

            if (SessionSkip.Contains(pid))
            {
                return;
            }

            if (TowerVesselCallsignGui.Visible)
            {
                return;
            }

            TowerVesselCallsignGui.Prompt(v);
        }
    }
}
