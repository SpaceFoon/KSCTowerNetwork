using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Spawns the voice-bridge process at boot when <see cref="TowerModSettings.AutoStartVoiceBridge"/> is enabled.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.FlightAndKSC, true)]
    public class TowerVoiceBridgeLauncher : MonoBehaviour
    {
        private static bool _attempted;

        private void Start()
        {
            TowerModSettings.EnsureVoiceBridgeKilledOnQuit();
            if (_attempted)
            {
                return;
            }

            _attempted = true;
            TowerModSettings.EnsureLoaded();
            TowerModSettings.TrySpawnVoiceBridgeProcess();
        }

        private void OnApplicationQuit()
        {
            TowerModSettings.StopSpawnedVoiceBridgeIfAny();
        }
    }
}
