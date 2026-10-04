using System;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Pure rules for helmet listen / BRIDGE annunciators (no Unity). Kept in one place so
    /// <see cref="TowerVoicePlayback"/> and the plugin-tests harness share the same behavior.
    /// </summary>
    public static class TowerVoiceListenUiLogic
    {
        public const double HeaderNegotiateGraceSeconds = 12.0;
        public const double FreshChunkMaxSeconds = 10.0;

        /// <summary>
        /// Same contract as <see cref="TowerVoicePlayback.IsListenUiOnAir"/> — all times UTC.
        /// </summary>
        public static bool IsListenUiOnAir(
            bool wantRun,
            bool threadAlive,
            long listenStartUtcTicks,
            bool hasStreamHeader,
            long lastChunkUtcTicks,
            DateTime utcNow)
        {
            if (!wantRun || !threadAlive)
            {
                return false;
            }

            var sessionAgeSec = listenStartUtcTicks <= 0
                ? 999.0
                : (utcNow - new DateTime(listenStartUtcTicks, DateTimeKind.Utc)).TotalSeconds;

            if (!hasStreamHeader)
            {
                return sessionAgeSec < HeaderNegotiateGraceSeconds;
            }

            var staleSec = lastChunkUtcTicks <= 0
                ? double.PositiveInfinity
                : (utcNow - new DateTime(lastChunkUtcTicks, DateTimeKind.Utc)).TotalSeconds;

            if (double.IsPositiveInfinity(staleSec))
            {
                return sessionAgeSec < HeaderNegotiateGraceSeconds;
            }

            return staleSec < FreshChunkMaxSeconds;
        }

        /// <summary>
        /// BRIDGE lamp in <see cref="TowerRadioGui"/>: control plane OK unless listen is on
        /// but the PCM path is stalled (matches in-game annunciator wiring).
        /// </summary>
        public static bool BridgeLedLit(bool bridgeControlOk, bool threadAlive, bool wantRun, bool listenUiOnAir)
        {
            return bridgeControlOk && !(threadAlive && wantRun && !listenUiOnAir);
        }

        /// <summary>
        /// Local ATIS loop should run only when the radio is powered, tuned to ATIS,
        /// and auth requirements are satisfied.
        /// </summary>
        public static bool ShouldRunAtisLoop(bool listenPowered, bool tunedAtis, bool authSatisfied)
        {
            return listenPowered && tunedAtis && authSatisfied;
        }
    }
}
