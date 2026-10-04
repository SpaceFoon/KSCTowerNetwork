using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Drives ASET COMM radio persistents from live tower downlink (<see cref="TowerVoicePlayback"/>)
    /// so MAS/RPM props can show receive activity (see <c>MM_AsetCommRadioTowerRxAnnunciator.cfg</c>).
    /// RMS smoothing thresholds live in <see cref="TowerCommRadioRxSyncMath"/> (unit-tested without KSP).
    /// </summary>
    public class TowerCommRadioRxSync : InternalModule
    {
        public const string RxCarrierPersistent = "KSCTOWER_COMM_RX";
        public const string RxLevelPersistent = "KSCTOWER_COMM_RX_LEVEL";

        private const string RadioPowerPersistent = "ASET_COMM_RADIO_TURN_ON";

        private float _smoothedRms;
        private int _lastRx;
        private double _lastLevel;

        public override void OnAwake()
        {
            Part part;
            if (TryGetLivePart(out part))
            {
                TowerCommRadioPersistents.Write(part, RxCarrierPersistent, 0.0);
                TowerCommRadioPersistents.Write(part, RxLevelPersistent, 0.0);
            }
        }

        public override void OnUpdate()
        {
            Part part;
            if (!TryGetLivePart(out part))
            {
                return;
            }

            if (FlightGlobals.ActiveVessel == null || part.vessel != FlightGlobals.ActiveVessel)
            {
                ClearRx(part);
                return;
            }

            if (!ReadRadioPowered(part))
            {
                ClearRx(part);
                return;
            }

            var v = TowerVoicePlayback.Instance;
            float target = 0f;
            if (v != null && v.WantsHelmetVoiceListen && v.HasStreamHeader)
            {
                target = v.LastOutputRms;
            }

            var dt = (double)Time.deltaTime;
            _smoothedRms = (float)TowerCommRadioRxSyncMath.StepSmoothedRms(_smoothedRms, target, dt);
            var rx = TowerCommRadioRxSyncMath.CarrierBit(_smoothedRms);
            var level = TowerCommRadioRxSyncMath.Level(_smoothedRms);

            if (TowerCommRadioRxSyncMath.ShouldWrite(_lastRx, _lastLevel, rx, level))
            {
                _lastRx = rx;
                _lastLevel = level;
                TowerCommRadioPersistents.Write(part, RxCarrierPersistent, rx);
                TowerCommRadioPersistents.Write(part, RxLevelPersistent, level);
            }
        }

        private void OnDestroy()
        {
            Part part;
            if (!TryGetLivePart(out part))
            {
                return;
            }

            ClearRx(part);
        }

        private void ClearRx(Part part)
        {
            _smoothedRms = 0f;
            if (_lastRx == 0 && _lastLevel <= 0.001)
            {
                return;
            }

            _lastRx = 0;
            _lastLevel = 0.0;
            TowerCommRadioPersistents.Write(part, RxCarrierPersistent, 0.0);
            TowerCommRadioPersistents.Write(part, RxLevelPersistent, 0.0);
        }

        private static bool ReadRadioPowered(Part part)
        {
            return TowerCommRadioPersistentValueParsing.AsBool(
                TowerCommRadioPersistents.Read(part, RadioPowerPersistent));
        }

        private bool TryGetLivePart(out Part part)
        {
            part = null;
            try
            {
                var prop = internalProp;
                if (prop == null)
                {
                    return false;
                }

                var p = prop.part;
                if (p == null)
                {
                    return false;
                }

                part = p;
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
