import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { TelemetrySample } from "./repository";
import { clearScoringState, detectFromTelemetry } from "./scoring";

const SID = "test-session-scoring";

describe("detectFromTelemetry", () => {
  beforeEach(() => {
    clearScoringState(SID);
  });

  it("emits liftoff when vertical speed crosses upward near the ground", () => {
    const prev: TelemetrySample = { verticalSpeed: 0, radarAlt: 20 };
    const curr: TelemetrySample = { verticalSpeed: 6, radarAlt: 10 };
    const events = detectFromTelemetry(prev, curr, SID, 1_000);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("liftoff"));
  });

  it("emits maxq when crossing Mach 1 below 30 km", () => {
    const prev: TelemetrySample = { surfaceSpeed: 300, aslAlt: 5000 };
    const curr: TelemetrySample = { surfaceSpeed: 350, aslAlt: 8000 };
    const events = detectFromTelemetry(prev, curr, SID, 2_000);
    assert.ok(events.some((e) => e.kind === "maxq"));
  });

  it("does not double-count liftoff within cooldown", () => {
    const prev: TelemetrySample = { verticalSpeed: 0, radarAlt: 15 };
    const curr: TelemetrySample = { verticalSpeed: 8, radarAlt: 12 };
    const first = detectFromTelemetry(prev, curr, SID, 3_000);
    assert.ok(first.some((e) => e.kind === "liftoff"));
    const again = detectFromTelemetry(curr, { ...curr, verticalSpeed: 9 }, SID, 3_005);
    assert.equal(again.filter((e) => e.kind === "liftoff").length, 0);
  });

  it("does not emit low_pass during TAKEOFF phase near KSC", () => {
    const prev: TelemetrySample = { surfaceSpeed: 90, aslAlt: 50, lat: -0.0972, lon: -74.5577 };
    const curr: TelemetrySample = {
      surfaceSpeed: 120,
      aslAlt: 50,
      lat: -0.0972,
      lon: -74.5577,
      flightPhase: "TAKEOFF"
    };
    const events = detectFromTelemetry(prev, curr, SID, 4_000);
    assert.equal(
      events.some((e) => e.kind === "low_pass"),
      false
    );
  });
});
