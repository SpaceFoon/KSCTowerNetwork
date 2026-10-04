import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { deriveCanonicalPhase, phaseTimelineTick, resetPhaseMachine } from "./phaseTimeline";

describe("deriveCanonicalPhase", () => {
  it("returns ON when grounded without taxi-above-20m", () => {
    assert.equal(deriveCanonicalPhase({ situation: "LANDED", flightPhase: "TAXI", radarAlt: 5 }), "ON");
    assert.equal(deriveCanonicalPhase({ situation: "SPLASHED" }), "ON");
    assert.equal(deriveCanonicalPhase({ situation: "prelanded" }), "ON");
  });

  it("returns IN for grounded taxi above 20m radar", () => {
    assert.equal(
      deriveCanonicalPhase({ situation: "PRELANDED", flightPhase: "TAXI", radarAlt: 25 }),
      "IN"
    );
  });

  it("returns APP when onApproach", () => {
    assert.equal(deriveCanonicalPhase({ onApproach: true, distKSC: 5000 }), "APP");
  });

  it("returns OUT/OFF from Kerbin distKSC thresholds", () => {
    assert.equal(deriveCanonicalPhase({ bodyName: "Kerbin", distKSC: 150_000 }), "OUT");
    assert.equal(deriveCanonicalPhase({ bodyName: "Kerbin", distKSC: 149_999 }), "OFF");
  });

  it("returns OFF for non-Kerbin airborne bodies", () => {
    assert.equal(deriveCanonicalPhase({ bodyName: "Mun", distKSC: 999_999 }), "OFF");
    assert.equal(deriveCanonicalPhase({ bodyName: undefined, distKSC: 999_999 }), "OFF");
  });
});

describe("phaseTimelineTick", () => {
  beforeEach(() => {
    resetPhaseMachine("sess-a");
  });

  it("commits immediately on first sample", () => {
    const ev = phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 200_000 }, 1000);
    assert.deepEqual(ev, { code: "OUT", at: new Date(1000).toISOString() });
  });

  it("requires 4s dwell before phase change", () => {
    phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 200_000 }, 1000);
    assert.equal(phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 1000 }, 2000), null);
    assert.equal(phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 1000 }, 5999), null);
    const ev = phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 1000 }, 6000);
    assert.deepEqual(ev, { code: "OFF", at: new Date(6000).toISOString() });
  });

  it("resets dwell when candidate changes before commit", () => {
    phaseTimelineTick("sess-a", { bodyName: "Kerbin", distKSC: 200_000 }, 1000);
    phaseTimelineTick("sess-a", { onApproach: true }, 2000);
    assert.equal(phaseTimelineTick("sess-a", { onApproach: true }, 5999), null);
    const ev = phaseTimelineTick("sess-a", { onApproach: true }, 6000);
    assert.deepEqual(ev, { code: "APP", at: new Date(6000).toISOString() });
  });
});
