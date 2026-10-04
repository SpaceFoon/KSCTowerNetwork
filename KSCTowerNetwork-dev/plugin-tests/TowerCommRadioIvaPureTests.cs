using System;
using KSCTowerNetwork;

/// <summary>
/// Unit tests for <see cref="TowerCommRadioRxSyncMath"/> and
/// <see cref="TowerCommRadioPersistentValueParsing"/> — no Unity / KSP.
/// </summary>
internal sealed class TowerCommRadioIvaPureTestRunner
{
    private static int Main()
    {
        var failed = 0;

        failed += ExpectD("ClampDeltaTime clamps high", 0.02, TowerCommRadioRxSyncMath.ClampDeltaTime(2.0));
        failed += ExpectD("ClampDeltaTime clamps zero", 0.02, TowerCommRadioRxSyncMath.ClampDeltaTime(0.0));
        failed += ExpectD("ClampDeltaTime keeps mid", 0.05, TowerCommRadioRxSyncMath.ClampDeltaTime(0.05));

        var s0 = 0.0;
        var s1 = TowerCommRadioRxSyncMath.StepSmoothedRms(s0, 1.0, 0.05);
        if (s1 <= s0 || s1 > 1.0)
        {
            failed++;
            Console.Error.WriteLine("FAIL: StepSmoothedRms moves toward target — got " + s1 + ".");
        }

        failed += ExpectI("carrier below threshold", 0, TowerCommRadioRxSyncMath.CarrierBit(0.001));
        failed += ExpectI("carrier at threshold", 1, TowerCommRadioRxSyncMath.CarrierBit(0.0045));
        failed += ExpectI("carrier above threshold", 1, TowerCommRadioRxSyncMath.CarrierBit(0.05));

        failed += ExpectD("level clamps high", 1.0, TowerCommRadioRxSyncMath.Level(1.0));
        failed += ExpectD("level zero", 0.0, TowerCommRadioRxSyncMath.Level(0.0));
        var quarterIn = 0.25 / TowerCommRadioRxSyncMath.LevelScale;
        failed += ExpectD("level linear quarter", 0.25, TowerCommRadioRxSyncMath.Level(quarterIn));

        failed += ExpectB("ShouldWrite rx change", true, TowerCommRadioRxSyncMath.ShouldWrite(0, 0.0, 1, 0.0));
        failed += ExpectB("ShouldWrite level jump", true, TowerCommRadioRxSyncMath.ShouldWrite(1, 0.0, 1, 0.5));
        failed += ExpectB("ShouldWrite no-op", false, TowerCommRadioRxSyncMath.ShouldWrite(1, 0.5, 1, 0.51));

        failed += ExpectB("AsBool null", false, TowerCommRadioPersistentValueParsing.AsBool(null));
        failed += ExpectB("AsBool empty string", false, TowerCommRadioPersistentValueParsing.AsBool(""));
        failed += ExpectB("AsBool int 1", true, TowerCommRadioPersistentValueParsing.AsBool(1));
        failed += ExpectB("AsBool int 0", false, TowerCommRadioPersistentValueParsing.AsBool(0));
        failed += ExpectB("AsBool string 1", true, TowerCommRadioPersistentValueParsing.AsBool("1"));
        failed += ExpectB("AsBool string 0.9", true, TowerCommRadioPersistentValueParsing.AsBool("0.9"));
        failed += ExpectB("AsBool string 0.4", false, TowerCommRadioPersistentValueParsing.AsBool("0.4"));
        failed += ExpectB("AsBool true", true, TowerCommRadioPersistentValueParsing.AsBool(true));

        if (failed > 0)
        {
            Console.Error.WriteLine("TowerCommRadioIvaPureTests: " + failed + " failure(s).");
            return 1;
        }

        Console.WriteLine("TowerCommRadioIvaPureTests: all checks passed.");
        return 0;
    }

    private static int ExpectD(string label, double want, double got)
    {
        if (Math.Abs(want - got) < 1e-9)
        {
            return 0;
        }

        Console.Error.WriteLine("FAIL: " + label + " — want " + want + ", got " + got + ".");
        return 1;
    }

    private static int ExpectI(string label, int want, int got)
    {
        if (want == got)
        {
            return 0;
        }

        Console.Error.WriteLine("FAIL: " + label + " — want " + want + ", got " + got + ".");
        return 1;
    }

    private static int ExpectB(string label, bool want, bool got)
    {
        if (want == got)
        {
            return 0;
        }

        Console.Error.WriteLine("FAIL: " + label + " — want " + want + ", got " + got + ".");
        return 1;
    }
}
