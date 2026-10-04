using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Registers Application.quitting so a KSP-spawned voice-bridge dies even when the player quits
    /// from the main menu (addons that only use FlightAndKSC may never have run yet).
    /// </summary>
    [KSPAddon(KSPAddon.Startup.MainMenu, true)]
    public class TowerVoiceBridgeMenuQuit : MonoBehaviour
    {
        private void Awake()
        {
            TowerModSettings.EnsureVoiceBridgeKilledOnQuit();
        }
    }
}
