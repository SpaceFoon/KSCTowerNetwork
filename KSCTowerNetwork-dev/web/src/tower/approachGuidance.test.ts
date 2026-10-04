import { describe, it, expect } from "vitest";
import { KERBIN_AERODROMES } from "../data/kerbinAeroCharts";
import {
  computeKkscTowerGuidance,
  haversineDistanceM,
  headingDiffDeg,
  latLonToEnM
} from "./approachGuidance";

const KKSC = KERBIN_AERODROMES.find((a) => a.id === "KKSC")!;
const R09 = KKSC.runways.find((r) => r.designator === "09")!;
const R27 = KKSC.runways.find((r) => r.designator === "27")!;

describe("headingDiffDeg", () => {
  it("wraps across 0/360", () => {
    expect(headingDiffDeg(350, 10)).toBeCloseTo(20, 5);
    expect(headingDiffDeg(10, 350)).toBeCloseTo(20, 5);
  });
  it("is symmetric", () => {
    expect(headingDiffDeg(90, 110)).toBeCloseTo(20, 5);
    expect(headingDiffDeg(110, 90)).toBeCloseTo(20, 5);
  });
});

describe("haversineDistanceM", () => {
  it("is zero for identical points", () => {
    expect(haversineDistanceM(-0.05, -74.6, -0.05, -74.6)).toBe(0);
  });
});

describe("latLonToEnM", () => {
  it("moves east when lon increases", () => {
    const o = latLonToEnM(0, 0, 0, 0, 600_000);
    const e = latLonToEnM(0, 1, 0, 0, 600_000);
    expect(e.x).toBeGreaterThan(o.x);
  });
});

describe("computeKkscTowerGuidance", () => {
  it("reports near-zero lateral on the runway threshold", () => {
    const g = computeKkscTowerGuidance({
      lat: R09.thresholdLat,
      lon: R09.thresholdLon,
      headingDeg: R09.headingDeg,
      radarAltM: 0,
      runwayPair: KKSC.runways,
      kscLat: -0.05,
      kscLon: -74.6,
      bodyRadiusM: 600_000
    });
    expect(Math.abs(g.lateralOffsetM)).toBeLessThan(50);
    expect(g.alongApproachM).toBeLessThan(500);
  });

  it("marks on-approach when aligned, low, and within cone", () => {
    const inbound = computeKkscTowerGuidance({
      lat: R09.thresholdLat,
      lon: R09.thresholdLon - 0.12,
      headingDeg: R09.headingDeg,
      radarAltM: 800,
      runwayPair: KKSC.runways,
      kscLat: R09.thresholdLat,
      kscLon: R09.thresholdLon,
      bodyRadiusM: 600_000
    });
    expect(inbound.onApproach).toBe(true);
    expect(inbound.kscDistanceKm).not.toBeNull();
  });

  it("marks glide HIGH when far above a 3° path", () => {
    const hi = computeKkscTowerGuidance({
      lat: R09.thresholdLat,
      lon: R09.thresholdLon - 0.18,
      headingDeg: R09.headingDeg,
      radarAltM: 5000,
      runwayPair: KKSC.runways,
      kscLat: R09.thresholdLat,
      kscLon: R09.thresholdLon,
      bodyRadiusM: 600_000
    });
    expect(hi.glide).toBe("HIGH");
  });

  it("selects runway 27 when heading matches 270°", () => {
    const g = computeKkscTowerGuidance({
      lat: R27.thresholdLat,
      lon: R27.thresholdLon,
      headingDeg: 270,
      radarAltM: 0,
      runwayPair: KKSC.runways,
      kscLat: -0.05,
      kscLon: -74.6,
      bodyRadiusM: 600_000
    });
    expect(g.runwayDesignator).toBe("27");
  });
});
