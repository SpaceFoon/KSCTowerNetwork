import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  getRunwayOccupancy,
  markRunwayLanding,
  resetRunwayOccupancyForTests,
  runwayKey,
  setRunwayManualOverride,
  snapshotAllOccupancy,
  tickRunwayOccupancyFromTelemetry
} from "./runwayState";

describe("runwayState", () => {
  beforeEach(() => {
    resetRunwayOccupancyForTests();
  });

  it("builds runway keys with trimmed runway id", () => {
    assert.equal(runwayKey("Kerbin", " 09 "), "Kerbin:09");
  });

  it("sets and clears manual override occupancy", () => {
    setRunwayManualOverride("Kerbin", "09", { occupied: true, bySessionId: "p1" });
    const rec = getRunwayOccupancy("Kerbin:09");
    assert.equal(rec?.occupied, true);
    assert.equal(rec?.bySessionId, "p1");
    assert.equal(rec?.manualOverride, true);

    setRunwayManualOverride("Kerbin", "09", { occupied: false });
    assert.equal(getRunwayOccupancy("Kerbin:09"), undefined);
  });

  it("marks on-surface telemetry as occupied at the threshold edge", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "27",
      sessionId: "s1",
      radarAlt: 54,
      surfaceSpeed: 37,
      alignErr: 13
    });
    const rec = getRunwayOccupancy("Kerbin:27");
    assert.equal(rec?.occupied, true);
    assert.equal(rec?.bySessionId, "s1");
    assert.equal(rec?.manualOverride, false);
  });

  it("does not mark occupancy above the on-surface thresholds", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "27",
      sessionId: "s1",
      radarAlt: 55,
      surfaceSpeed: 37,
      alignErr: 13
    });
    assert.equal(getRunwayOccupancy("Kerbin:27"), undefined);
  });

  it("ignores telemetry updates while manual override is active", () => {
    setRunwayManualOverride("Kerbin", "09", { occupied: true, bySessionId: "manual" });
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "telemetry",
      radarAlt: 5,
      surfaceSpeed: 10,
      alignErr: 1
    });
    assert.equal(getRunwayOccupancy("Kerbin:09")?.bySessionId, "manual");
  });

  it("clears occupancy when the same session departs via radar altitude", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 10,
      surfaceSpeed: 20,
      alignErr: 5
    });
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 201,
      surfaceSpeed: 20,
      alignErr: 5
    });
    assert.equal(getRunwayOccupancy("Kerbin:09"), undefined);
  });

  it("clears occupancy when the same session departs via surface speed", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 10,
      surfaceSpeed: 20,
      alignErr: 5
    });
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 10,
      surfaceSpeed: 56,
      alignErr: 5
    });
    assert.equal(getRunwayOccupancy("Kerbin:09"), undefined);
  });

  it("does not clear occupancy for a different session on departure", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 10,
      surfaceSpeed: 20,
      alignErr: 5
    });
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s2",
      radarAlt: 250,
      surfaceSpeed: 60,
      alignErr: 5
    });
    assert.equal(getRunwayOccupancy("Kerbin:09")?.bySessionId, "s1");
  });

  it("does not mark occupancy when only one surface metric is out of range", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 54,
      surfaceSpeed: 38,
      alignErr: 13
    });
    assert.equal(getRunwayOccupancy("Kerbin:09"), undefined);
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 54,
      surfaceSpeed: 37,
      alignErr: 14
    });
    assert.equal(getRunwayOccupancy("Kerbin:09"), undefined);
  });

  it("preserves sinceMs for the same session holding the runway", () => {
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 10,
      surfaceSpeed: 20,
      alignErr: 5
    });
    const firstSince = getRunwayOccupancy("Kerbin:09")?.sinceMs;
    tickRunwayOccupancyFromTelemetry({
      bodyName: "Kerbin",
      runwayId: "09",
      sessionId: "s1",
      radarAlt: 12,
      surfaceSpeed: 22,
      alignErr: 4
    });
    assert.equal(getRunwayOccupancy("Kerbin:09")?.sinceMs, firstSince);
  });

  it("records landing timestamps and snapshots occupancy keys", () => {
    markRunwayLanding("Kerbin", "09");
    const snap = snapshotAllOccupancy();
    assert.equal(snap.length, 1);
    assert.equal(snap[0]?.key, "Kerbin:09");
    assert.equal(snap[0]?.bodyName, "Kerbin");
    assert.equal(snap[0]?.runwayId, "09");
    assert.equal(snap[0]?.record.occupied, true);
    assert.ok((snap[0]?.record.lastLandingAtMs ?? 0) > 0);
  });
});
