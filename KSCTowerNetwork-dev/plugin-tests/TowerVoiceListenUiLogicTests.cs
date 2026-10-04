using System;
using KSCTowerNetwork;

/// <summary>
/// Minimal harness for <see cref="TowerVoiceListenUiLogic"/> — compiled and run by
/// <c>plugin-tests/run-listen-ui-tests.ps1</c> (no Unity / KSP references).
/// </summary>
internal sealed class TowerVoiceListenUiTestRunner
{
    private static int Main()
    {
        var failed = 0;
        var t0 = new DateTime(2026, 4, 24, 12, 0, 0, DateTimeKind.Utc);
        var t0Ticks = t0.Ticks;

        failed += Expect(
            "off when wantRun false",
            false,
            TowerVoiceListenUiLogic.IsListenUiOnAir(false, true, t0Ticks, false, 0, t0.AddSeconds(6)));

        failed += Expect(
            "off when thread dead",
            false,
            TowerVoiceListenUiLogic.IsListenUiOnAir(true, false, t0Ticks, false, 0, t0.AddSeconds(6)));

        failed += Expect(
            "on during header grace (6s)",
            true,
            TowerVoiceListenUiLogic.IsListenUiOnAir(true, true, t0Ticks, false, 0, t0.AddSeconds(6)));

        failed += Expect(
            "off after header grace (13s, no header)",
            false,
            TowerVoiceListenUiLogic.IsListenUiOnAir(true, true, t0Ticks, false, 0, t0.AddSeconds(13)));

        failed += Expect(
            "on with header and fresh chunk (5s)",
            true,
            TowerVoiceListenUiLogic.IsListenUiOnAir(
                true,
                true,
                t0Ticks,
                true,
                t0.AddSeconds(-5).Ticks,
                t0));

        failed += Expect(
            "off with header and stale chunk (11s)",
            false,
            TowerVoiceListenUiLogic.IsListenUiOnAir(
                true,
                true,
                t0Ticks,
                true,
                t0.AddSeconds(-11).Ticks,
                t0));

        failed += Expect(
            "header on but no chunk ticks yet — grace (6s session)",
            true,
            TowerVoiceListenUiLogic.IsListenUiOnAir(true, true, t0Ticks, true, 0, t0.AddSeconds(6)));

        failed += Expect(
            "header on but no chunk ticks — past grace (13s session)",
            false,
            TowerVoiceListenUiLogic.IsListenUiOnAir(true, true, t0Ticks, true, 0, t0.AddSeconds(13)));

        failed += Expect(
            "BRIDGE lit when control ok and not listening",
            true,
            TowerVoiceListenUiLogic.BridgeLedLit(true, false, false, false));

        failed += Expect(
            "BRIDGE lit when control ok and listen healthy",
            true,
            TowerVoiceListenUiLogic.BridgeLedLit(true, true, true, true));

        failed += Expect(
            "BRIDGE dark when control ok but listen stalled",
            false,
            TowerVoiceListenUiLogic.BridgeLedLit(true, true, true, false));

        failed += Expect(
            "BRIDGE dark when control dead even if listen claims healthy",
            false,
            TowerVoiceListenUiLogic.BridgeLedLit(false, true, true, true));

        failed += Expect(
            "ATIS loop off when radio power is off",
            false,
            TowerVoiceListenUiLogic.ShouldRunAtisLoop(false, true, true));

        failed += Expect(
            "ATIS loop off when not tuned to ATIS",
            false,
            TowerVoiceListenUiLogic.ShouldRunAtisLoop(true, false, true));

        failed += Expect(
            "ATIS loop off when auth requirements are not satisfied",
            false,
            TowerVoiceListenUiLogic.ShouldRunAtisLoop(true, true, false));

        failed += Expect(
            "ATIS loop on only when power+tuned+auth are all true",
            true,
            TowerVoiceListenUiLogic.ShouldRunAtisLoop(true, true, true));

        if (failed > 0)
        {
            Console.Error.WriteLine("TowerVoiceListenUiLogicTests: " + failed + " failure(s).");
            return 1;
        }

        Console.WriteLine("TowerVoiceListenUiLogicTests: all checks passed.");
        return 0;
    }

    private static int Expect(string label, bool want, bool got)
    {
        if (want == got)
        {
            return 0;
        }

        Console.Error.WriteLine("FAIL: " + label + " — want " + want + ", got " + got + ".");
        return 1;
    }
}
