import { describe, expect, it } from "vitest";
import { compassPoint, flightWallGuidance } from "./flightWallGuidance";
import { activeRowToTelemetry } from "./towerAircraftTracks";
import { kerbinDistanceMeters } from "./airfieldGeometry";

describe("flightwall guidance", () => {
  const now = 1_000_000;
  const fresh = { sampleUnixMs: now - 1_000, situation: "FLYING" };
  it("distinguishes inbound, outbound and crossing headings", () => {
    expect(flightWallGuidance({ ...fresh, heading: 270 }, 10, 90, now).state).toBe("inbound");
    expect(flightWallGuidance({ ...fresh, heading: 90 }, 10, 90, now).state).toBe("outbound");
    expect(flightWallGuidance({ ...fresh, heading: 0 }, 10, 90, now).state).toBe("passing");
  });
  it("does not describe missing, invalid or stale telemetry as live", () => {
    for (const timestamp of [undefined, NaN, now - 20_000, now + 100_000]) {
      expect(flightWallGuidance({ sampleUnixMs: timestamp, onApproach: true }, 5, 0, now).state).toBe("stale");
    }
    expect(flightWallGuidance({ ...fresh, sampleUnixMs: now - 20_000 }, 5, 0, now, 60_000).state).not.toBe("stale");
  });
  it("respects ground, approach and orbital states", () => {
    expect(flightWallGuidance({ ...fresh, situation: "LANDED" }, 0, 0, now).state).toBe("ground");
    expect(flightWallGuidance({ ...fresh, onApproach: true, targetRunway: "KSC 09" }, 8, 0, now).detail).toContain("KSC 09");
    expect(flightWallGuidance({ ...fresh, situation: "ORBITING" }, 8, 0, now).state).toBe("orbit");
    expect(flightWallGuidance(fresh, 8, 0, now).state).toBe("flight");
  });
  it("wraps compass bearings and measures across the dateline", () => {
    expect(compassPoint(360)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
    expect(kerbinDistanceMeters(0, 179.9, 0, -179.9)).toBeCloseTo(2094.395, 2);
    expect(kerbinDistanceMeters(90, 0, -90, 180)).toBeCloseTo(Math.PI * 600000, 3);
  });
  it("preserves server receipt time and runway for another pilot's card", () => {
    const result = activeRowToTelemetry({ sessionId: "other", lastTelemetryAt: "2026-10-04T12:00:00Z", targetRunway: "KSC 27" });
    expect(result.sampleUnixMs).toBe(Date.parse("2026-10-04T12:00:00Z"));
    expect(result.targetRunway).toBe("KSC 27");
    expect(activeRowToTelemetry({ sessionId: "other", lastTelemetryAt: "2026-10-04T12:00:00Z", telemetryHealthState: "beacon_off" }).sampleUnixMs).toBeNaN();
  });
});
