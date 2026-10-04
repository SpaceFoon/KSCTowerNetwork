import { describe, it, expect } from "vitest";
import { pttGateMicOpen } from "./pttGate";

describe("pttGateMicOpen (VoiceDesk PTT + KSP bridge)", () => {
  it("opens mic when tower holds PTT even if bridge is off", () => {
    expect(
      pttGateMicOpen({
        pttMode: true,
        towerPhysicalHeld: true,
        bridgePttFromKsp: false,
        manualUnmuted: false
      })
    ).toBe(true);
  });

  it("opens mic when KSP bridge MIC_ON even if tower key not held", () => {
    expect(
      pttGateMicOpen({
        pttMode: true,
        towerPhysicalHeld: false,
        bridgePttFromKsp: true,
        manualUnmuted: false
      })
    ).toBe(true);
  });

  it("keeps mic closed when neither tower nor bridge in PTT mode", () => {
    expect(
      pttGateMicOpen({
        pttMode: true,
        towerPhysicalHeld: false,
        bridgePttFromKsp: false,
        manualUnmuted: true
      })
    ).toBe(false);
  });

  it("opens when both tower and bridge want transmit", () => {
    expect(
      pttGateMicOpen({
        pttMode: true,
        towerPhysicalHeld: true,
        bridgePttFromKsp: true,
        manualUnmuted: false
      })
    ).toBe(true);
  });

  it("opens from bridge when tower PTT is off (open-mic mode)", () => {
    expect(
      pttGateMicOpen({
        pttMode: false,
        towerPhysicalHeld: false,
        bridgePttFromKsp: true,
        manualUnmuted: false
      })
    ).toBe(true);
  });

  it("respects manual mute when tower PTT is off and bridge is off", () => {
    expect(
      pttGateMicOpen({
        pttMode: false,
        towerPhysicalHeld: false,
        bridgePttFromKsp: false,
        manualUnmuted: false
      })
    ).toBe(false);
  });

  it("allows manual unmute when tower PTT is off and bridge is off", () => {
    expect(
      pttGateMicOpen({
        pttMode: false,
        towerPhysicalHeld: false,
        bridgePttFromKsp: false,
        manualUnmuted: true
      })
    ).toBe(true);
  });
});
