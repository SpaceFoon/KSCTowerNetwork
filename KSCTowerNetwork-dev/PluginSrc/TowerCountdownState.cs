using System;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Shared, in-memory snapshot of the synced launch countdown for the active session.
    ///
    /// Filled by <see cref="TowerTelemetryPublisher"/> from the JSON response of
    /// <c>POST /v1/telemetry/{sessionId}</c> (the response carries <c>countdown.startsAtMs</c>,
    /// <c>countdown.lengthSec</c>, and <c>serverNowMs</c>). Read by <see cref="TowerCountdownHud"/>
    /// to render the in-game HUD overlay.
    ///
    /// We translate the server epoch into a local <see cref="UnityEngine.Time.realtimeSinceStartup"/>
    /// reference by computing <c>localStartRealtime = Time.realtimeSinceStartup + (startsAtMs - serverNowMs) / 1000</c>.
    /// That avoids any clock-drift between the player's PC and the backend host (their wall clocks
    /// can differ by minutes; only relative time matters for a 10s countdown).
    /// </summary>
    public static class TowerCountdownState
    {
        private static readonly object _gate = new object();

        private static bool _active;
        private static double _startsAtRealtime;
        private static int _lengthSec;
        private static long _lastUpdatedUnixMs;

        /// <summary>True when a countdown was reported by the server and has not passed T+grace.</summary>
        public static bool Active
        {
            get { lock (_gate) { return _active; } }
        }

        /// <summary>
        /// Seconds remaining until T-0 in the player's local clock. Negative values mean we are past
        /// T-0 (the HUD shows "LIFTOFF" briefly then clears). Returns <see cref="float.NaN"/> when
        /// no countdown is active.
        /// </summary>
        public static float SecondsRemaining
        {
            get
            {
                lock (_gate)
                {
                    if (!_active)
                    {
                        return float.NaN;
                    }

                    var nowRealtime = (double)UnityEngine.Time.realtimeSinceStartup;
                    var endRealtime = _startsAtRealtime + _lengthSec;
                    return (float)(endRealtime - nowRealtime);
                }
            }
        }

        public static int LengthSec
        {
            get { lock (_gate) { return _lengthSec; } }
        }

        public static long LastUpdatedUnixMs
        {
            get { lock (_gate) { return _lastUpdatedUnixMs; } }
        }

        /// <summary>
        /// Update the state from a fresh telemetry response. <paramref name="startsAtMs"/> is the
        /// server-side epoch ms of when the countdown was started; <paramref name="serverNowMs"/>
        /// is the server's "now" at the moment the response was generated. Both are translated into
        /// local <see cref="UnityEngine.Time.realtimeSinceStartup"/> so the local clock can render
        /// without re-polling for every tick.
        /// </summary>
        public static void Apply(long startsAtMs, int lengthSec, long serverNowMs)
        {
            lock (_gate)
            {
                var nowRealtime = (double)UnityEngine.Time.realtimeSinceStartup;
                var deltaSec = (startsAtMs - serverNowMs) / 1000.0;
                _startsAtRealtime = nowRealtime + deltaSec;
                _lengthSec = lengthSec;
                _active = true;
                _lastUpdatedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }

        /// <summary>Called when telemetry no longer reports an active countdown (scrubbed or finished).</summary>
        public static void Clear()
        {
            lock (_gate)
            {
                _active = false;
                _startsAtRealtime = 0;
                _lengthSec = 0;
                _lastUpdatedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }
    }
}
