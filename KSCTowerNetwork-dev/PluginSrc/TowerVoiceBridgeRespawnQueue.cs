using System.Threading;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Background threads (the voice TCP reader) can ask for a bridge respawn, but
    /// <see cref="TowerModSettings.TryRespawnVoiceBridgeProcess"/> touches KSP/Unity state and is safest on the
    /// main thread. This class is a tiny rate-limited flag that the main thread drains each frame.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Instantly, true)]
    public class TowerVoiceBridgeRespawnQueue : MonoBehaviour
    {
        private static int _pending;
        private static float _nextAllowedRespawnTime;
        private const float MinSecondsBetweenRespawns = 6f;

        /// <summary>Mark that a bridge respawn is desired. Safe to call from any thread.</summary>
        public static void RequestRespawn()
        {
            Interlocked.Exchange(ref _pending, 1);
        }

        private void Update()
        {
            if (Interlocked.Exchange(ref _pending, 0) == 0)
            {
                return;
            }

            if (Time.realtimeSinceStartup < _nextAllowedRespawnTime)
            {
                return;
            }

            _nextAllowedRespawnTime = Time.realtimeSinceStartup + MinSecondsBetweenRespawns;

            TowerModSettings.EnsureLoaded();
            if (string.IsNullOrEmpty(TowerModSettings.BridgeExecutable))
            {
                // Nothing to respawn — user launches the bridge manually. Stay quiet in the log.
                return;
            }

            Debug.Log("[KSCTowerNetwork] voice bridge looks dead — attempting respawn");
            TowerModSettings.TryRespawnVoiceBridgeProcess();
        }
    }
}
