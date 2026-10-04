using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// In-memory "tower cleared you for takeoff" window driven by <see cref="TowerTelemetryPublisher"/>
    /// parsing <c>takeoffClearanceAtMs</c> + <c>serverNowMs</c> on each telemetry reply. The radio
    /// request row shows a green <b>APPROVED</b> label for the remaining wall-clock window (10 s
    /// from grant, server-authoritative).
    /// </summary>
    public static class TowerTakeoffClearanceState
    {
        private static readonly object _gate = new object();

        /// <summary>Local <see cref="Time.realtimeSinceStartup"/> deadline; 0 = inactive.</summary>
        private static double _approvedEndRealtime;

        public static bool IsActive
        {
            get
            {
                lock (_gate)
                {
                    if (_approvedEndRealtime <= 0)
                    {
                        return false;
                    }

                    return Time.realtimeSinceStartup < _approvedEndRealtime;
                }
            }
        }

        /// <summary>
        /// <paramref name="grantedAtMs"/> is server epoch ms when clearance was recorded;
        /// <paramref name="serverNowMs"/> is the server's clock at telemetry encode time.
        /// </summary>
        public static void Apply(long grantedAtMs, long serverNowMs)
        {
            lock (_gate)
            {
                var remainingMs = grantedAtMs + 10000L - serverNowMs;
                if (remainingMs <= 0)
                {
                    _approvedEndRealtime = 0;
                    return;
                }

                var nowRt = (double)Time.realtimeSinceStartup;
                _approvedEndRealtime = nowRt + remainingMs / 1000.0;
            }
        }

        public static void Clear()
        {
            lock (_gate)
            {
                _approvedEndRealtime = 0;
            }
        }
    }
}
