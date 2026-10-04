/**
 * Client preview scoring must stay aligned with backend `scoring.ts` (see module comment there).
 */
import { describe, expect, it } from "vitest";
import { clearPreviewState, detectFromTelemetryClient } from "./rules";

const SID = "preview-test-session";

describe("detectFromTelemetryClient", () => {
  it("matches backend liftoff + maxq smoke cases", () => {
    clearPreviewState(SID);
    const liftoff = detectFromTelemetryClient(
      { verticalSpeed: 0, radarAlt: 20 },
      { verticalSpeed: 6, radarAlt: 20 },
      SID,
      1_000_000
    );
    expect(liftoff.some((e) => e.kind === "liftoff")).toBe(true);

    clearPreviewState(SID);
    const maxq = detectFromTelemetryClient(
      { surfaceSpeed: 300, aslAlt: 15000 },
      { surfaceSpeed: 350, aslAlt: 15000 },
      SID,
      1_000_001
    );
    expect(maxq.some((e) => e.kind === "maxq")).toBe(true);
  });

  it("suppresses low_pass during TAKEOFF like the backend", () => {
    clearPreviewState(SID);
    const events = detectFromTelemetryClient(
      { surfaceSpeed: 90, aslAlt: 50, lat: -0.0972, lon: -74.5577 },
      {
        surfaceSpeed: 120,
        aslAlt: 50,
        lat: -0.0972,
        lon: -74.5577,
        flightPhase: "TAKEOFF"
      },
      SID,
      2_000_000
    );
    expect(events.some((e) => e.kind === "low_pass")).toBe(false);
  });
});
