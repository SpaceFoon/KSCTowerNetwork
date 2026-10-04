import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeApproachSequences } from "./approachQueue";
import { haversineKm } from "./geo";
import { computeSeparationConflicts } from "./separation";
import { landingQualityFromSamples } from "./landingQuality";

describe("computeApproachSequences", () => {
  it("skips rows that are not on approach or lack active runway", () => {
    const m = computeApproachSequences([
      { sessionId: "skip-a", bodyName: "Kerbin", onApproach: false, activeRunway: "09", distKSC: 100 },
      { sessionId: "skip-b", bodyName: "Kerbin", onApproach: true, activeRunway: "  ", distKSC: 100 },
      { sessionId: "keep", bodyName: "Kerbin", onApproach: true, activeRunway: "09", distKSC: 1000 }
    ]);
    assert.equal(m.size, 1);
    assert.deepEqual(m.get("keep"), { index: 1, of: 1, gapKmBehindLeader: undefined });
  });

  it("requires trimmed active runway ids when grouping", () => {
    const m = computeApproachSequences([
      { sessionId: "spaced", bodyName: "Kerbin", onApproach: true, activeRunway: " 09 ", distKSC: 1000 },
      { sessionId: "plain", bodyName: "Kerbin", onApproach: true, activeRunway: "09", distKSC: 2000 }
    ]);
    assert.equal(m.get("spaced")?.of, 2);
    assert.equal(m.get("plain")?.of, 2);
    assert.equal(m.get("spaced")?.index, 1);
    assert.equal(m.get("plain")?.index, 2);
  });

  it("orders by distKSC even when input order is reversed", () => {
    const m = computeApproachSequences([
      {
        sessionId: "far",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 9000,
        lat: 0.052,
        lon: -74.5
      },
      {
        sessionId: "near",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 1000,
        lat: 0.05,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("near")?.index, 1);
    assert.equal(m.get("far")?.index, 2);
    assert.ok((m.get("far")?.gapKmBehindLeader ?? 0) > 0);
  });

  it("breaks distKSC ties by alignErr with reversed input order", () => {
    const m = computeApproachSequences([
      {
        sessionId: "worse",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 3,
        lat: 0.05,
        lon: -74.5
      },
      {
        sessionId: "better",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        lat: 0.051,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("better")?.index, 1);
    assert.equal(m.get("worse")?.index, 2);
  });

  it("breaks alignErr ties by lower radar altitude with reversed input order", () => {
    const m = computeApproachSequences([
      {
        sessionId: "low",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        radarAlt: 500,
        lat: 0.051,
        lon: -74.5
      },
      {
        sessionId: "high",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        radarAlt: 600,
        lat: 0.05,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("high")?.index, 1);
    assert.equal(m.get("low")?.index, 2);
  });

  it("uses aslAlt when radarAlt is missing and breaks ties with reversed input order", () => {
    const m = computeApproachSequences([
      {
        sessionId: "low",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        aslAlt: 500,
        lat: 0.051,
        lon: -74.5
      },
      {
        sessionId: "high",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        aslAlt: 600,
        lat: 0.05,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("high")?.index, 1);
    assert.equal(m.get("low")?.index, 2);
  });

  it("breaks remaining ties by sessionId lexicographic order", () => {
    const m = computeApproachSequences([
      {
        sessionId: "zulu",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        radarAlt: 500,
        lat: 0.05,
        lon: -74.5
      },
      {
        sessionId: "alpha",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 5000,
        alignErr: 1,
        radarAlt: 500,
        lat: 0.05,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("alpha")?.index, 1);
    assert.equal(m.get("zulu")?.index, 2);
  });

  it("omits gap distance when lat/lon are incomplete", () => {
    const m = computeApproachSequences([
      {
        sessionId: "lead",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 1000,
        lat: 0.05,
        lon: -74.5
      },
      {
        sessionId: "trail",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 2000
      }
    ]);
    assert.equal(m.get("trail")?.index, 2);
    assert.equal(m.get("trail")?.gapKmBehindLeader, undefined);
  });

  it("sorts missing distKSC rows after finite distances", () => {
    const m = computeApproachSequences([
      {
        sessionId: "unknown",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        lat: 0.05,
        lon: -74.5
      },
      {
        sessionId: "near",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 1000,
        lat: 0.051,
        lon: -74.5
      }
    ]);
    assert.equal(m.get("near")?.index, 1);
    assert.equal(m.get("unknown")?.index, 2);
  });

  it("computes exact gap distance behind the leader", () => {
    const m = computeApproachSequences([
      {
        sessionId: "lead",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 1000,
        lat: 0.05,
        lon: -74.5
      },
      {
        sessionId: "trail",
        bodyName: "Kerbin",
        activeRunway: "09",
        onApproach: true,
        distKSC: 2000,
        lat: 0.051,
        lon: -74.5
      }
    ]);
    assert.ok(
      Math.abs((m.get("trail")?.gapKmBehindLeader ?? 0) - 0.010471975511965916) < 1e-9
    );
  });

  it("groups by body and runway independently", () => {
    const m = computeApproachSequences([
      { sessionId: "r27", bodyName: "Kerbin", activeRunway: "27", onApproach: true, distKSC: 2000 },
      { sessionId: "r09", bodyName: "Kerbin", activeRunway: "09", onApproach: true, distKSC: 1000 }
    ]);
    assert.equal(m.get("r09")?.of, 1);
    assert.equal(m.get("r27")?.of, 1);
  });
});

describe("computeSeparationConflicts", () => {
  it("returns no conflicts across different bodies or missing coordinates", () => {
    assert.deepEqual(
      computeSeparationConflicts([
        { sessionId: "a", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
        { sessionId: "b", bodyName: "Mun", lat: 0.1, lon: -74.5, aslAlt: 1000 }
      ]),
      []
    );
    assert.deepEqual(
      computeSeparationConflicts([
        { sessionId: "a", bodyName: "Kerbin", lat: 0.1, aslAlt: 1000 },
        { sessionId: "b", bodyName: "Kerbin", lon: -74.5, aslAlt: 1000 }
      ]),
      []
    );
  });

  it("flags conflict under 2 km horizontal and 300 m vertical", () => {
    const c = computeSeparationConflicts(
      [
        { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000, callsign: "ALPHA" },
        { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1100, callsign: "BRAVO" }
      ],
      600_000
    );
    assert.deepEqual(c, [
      { sessionA: "x", sessionB: "y", callsignA: "ALPHA", callsignB: "BRAVO" }
    ]);
  });

  it("ignores pairs separated horizontally by at least 2 km", () => {
    let farLat = 0.1;
    while (haversineKm(0.1, -74.5, farLat, -74.5, 600_000) < 2) {
      farLat += 0.01;
    }
    const c = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
      { sessionId: "y", bodyName: "Kerbin", lat: farLat, lon: -74.5, aslAlt: 1000 }
    ]);
    assert.deepEqual(c, []);
  });

  it("ignores pairs separated vertically by 300 m or more", () => {
    const c = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
      { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1400 }
    ]);
    assert.deepEqual(c, []);
  });

  it("ignores non-finite altitudes", () => {
    const c = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: Number.NaN },
      { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1100 }
    ]);
    assert.deepEqual(c, []);
  });

  it("flags conflict at 299 m vertical separation but not at 300 m", () => {
    const close = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
      { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1299 }
    ]);
    assert.equal(close.length, 1);
    const far = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
      { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1300 }
    ]);
    assert.deepEqual(far, []);
  });

  it("uses radarAlt before aslAlt for separation checks", () => {
    const c = computeSeparationConflicts([
      { sessionId: "x", bodyName: "Kerbin", lat: 0.1, lon: -74.5, radarAlt: 1000, aslAlt: 2000 },
      { sessionId: "y", bodyName: "Kerbin", lat: 0.101, lon: -74.5, radarAlt: 1100, aslAlt: 2000 }
    ]);
    assert.equal(c.length, 1);
  });

  it("checks every unique pair in a three-aircraft cluster", () => {
    const c = computeSeparationConflicts([
      { sessionId: "a", bodyName: "Kerbin", lat: 0.1, lon: -74.5, aslAlt: 1000 },
      { sessionId: "b", bodyName: "Kerbin", lat: 0.101, lon: -74.5, aslAlt: 1100 },
      { sessionId: "c", bodyName: "Kerbin", lat: 0.102, lon: -74.5, aslAlt: 1200 }
    ]);
    assert.equal(c.length, 3);
  });
});

describe("landingQualityFromSamples", () => {
  it("returns GOOD inside both thresholds", () => {
    assert.equal(landingQualityFromSamples(4, -3.5), "GOOD");
    assert.equal(landingQualityFromSamples(undefined, undefined), "OFF_CENTER");
  });

  it("returns HARD when only one dimension exceeds the soft threshold", () => {
    assert.equal(landingQualityFromSamples(4.1, 0), "HARD");
    assert.equal(landingQualityFromSamples(0, -3.6), "HARD");
    assert.equal(landingQualityFromSamples(8, -6), "HARD");
  });

  it("returns OFF_CENTER when alignment or sink rate exceeds hard limits", () => {
    assert.equal(landingQualityFromSamples(8.1, 0), "OFF_CENTER");
    assert.equal(landingQualityFromSamples(0, -6.1), "OFF_CENTER");
  });
});
