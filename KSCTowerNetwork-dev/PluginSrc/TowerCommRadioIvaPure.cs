using System;
using System.Globalization;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Pure helpers for IVA COMM radio integration — no Unity types. Covered by
    /// <c>plugin-tests/run-comm-radio-pure-tests.ps1</c> alongside the flight plugin build.
    /// </summary>
    public static class TowerCommRadioRxSyncMath
    {
        public const double CarrierThreshold = 0.0045;
        public const double SmoothingHz = 20.0;
        public const double LevelScale = 14.0;
        public const double MaxDt = 0.5;
        public const double DefaultDt = 0.02;
        public const double LevelWriteEpsilon = 0.03;

        public static double ClampDeltaTime(double dt)
        {
            if (dt <= 0.0 || dt > MaxDt)
            {
                return DefaultDt;
            }

            return dt;
        }

        public static double StepSmoothedRms(double smoothed, double target, double dt)
        {
            dt = ClampDeltaTime(dt);
            var alpha = 1.0 - Math.Exp(-SmoothingHz * dt);
            return smoothed + (target - smoothed) * alpha;
        }

        public static int CarrierBit(double smoothedRms)
        {
            return smoothedRms >= CarrierThreshold ? 1 : 0;
        }

        public static double Level(double smoothedRms)
        {
            var v = smoothedRms * LevelScale;
            if (v < 0.0)
            {
                return 0.0;
            }

            if (v > 1.0)
            {
                return 1.0;
            }

            return v;
        }

        public static bool ShouldWrite(int prevRx, double prevLevel, int rx, double level)
        {
            return rx != prevRx || Math.Abs(level - prevLevel) > LevelWriteEpsilon;
        }
    }

    /// <summary>
    /// Interprets RPM/MAS persistent values as booleans (radio power, PTT, etc.).
    /// </summary>
    public static class TowerCommRadioPersistentValueParsing
    {
        public static bool AsBool(object v)
        {
            if (v == null)
            {
                return false;
            }

            if (v is bool)
            {
                return (bool)v;
            }

            if (v is int)
            {
                return (int)v != 0;
            }

            if (v is long)
            {
                return (long)v != 0;
            }

            if (v is float)
            {
                return (float)v >= 0.5f;
            }

            if (v is double)
            {
                return (double)v >= 0.5;
            }

            var s = v as string;
            if (s != null)
            {
                if (string.IsNullOrEmpty(s))
                {
                    return false;
                }

                bool parsedBool;
                if (bool.TryParse(s, out parsedBool))
                {
                    return parsedBool;
                }

                double parsedNum;
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out parsedNum))
                {
                    return parsedNum >= 0.5;
                }

                return false;
            }

            try
            {
                return Convert.ToDouble(v, CultureInfo.InvariantCulture) >= 0.5;
            }
            catch
            {
                return false;
            }
        }
    }
}
