import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  isArrivalTouchdown,
  isTouchdownTransition,
  missedApproachCandidate,
  publisherDepartureClimbPhase,
  publisherLandingApproachIntent
} from "./flightEdges";

describe("publisherLandingApproachIntent", () => {
  it("is false for missing telemetry", () => {
    assert.equal(publisherLandingApproachIntent(undefined), false);
  });

  it("is true for plugin landing flag or APPROACH/LANDING phase", () => {
    assert.equal(publisherLandingApproachIntent({ landing: true }), true);
    assert.equal(publisherLandingApproachIntent({ flightPhase: "APPROACH" }), true);
    assert.equal(publisherLandingApproachIntent({ flightPhase: "final_landing" }), true);
    assert.equal(publisherLandingApproachIntent({ flightPhase: "TAKEOFF" }), false);
    assert.equal(publisherLandingApproachIntent({ flightPhase: "CRUISE" }), false);
    assert.equal(publisherLandingApproachIntent({ flightPhase: undefined }), false);
  });
});

describe("missedApproachCandidate", () => {
  const basePrev = {
    onApproach: true,
    distKSC: 2000,
    verticalSpeed: -5,
    aslAlt: 200,
    radarAlt: 200,
    flightPhase: "LANDING",
    landing: true
  };
  const climbCurr = {
    onApproach: true,
    distKSC: 2000,
    verticalSpeed: 10,
    aslAlt: 220,
    radarAlt: 220,
    flightPhase: "TAKEOFF"
  };

  it("requires onApproach on the current sample", () => {
    assert.equal(missedApproachCandidate(basePrev, { ...climbCurr, onApproach: false }), false);
  });

  it("does not fire far from the field", () => {
    assert.equal(missedApproachCandidate(basePrev, { ...climbCurr, distKSC: 3000 }), false);
    assert.equal(missedApproachCandidate(basePrev, { ...climbCurr, distKSC: 2999 }), true);
  });

  it("does not fire for takeoff-like phases without approach intent", () => {
    assert.equal(
      missedApproachCandidate(
        { ...basePrev, flightPhase: "TAKEOFF", landing: false },
        { ...climbCurr, flightPhase: "TAKEOFF" }
      ),
      false
    );
  });

  it("fires when vertical speed exceeds 2 m/s during approach intent", () => {
    assert.equal(
      missedApproachCandidate(basePrev, { ...climbCurr, verticalSpeed: 2, aslAlt: 200, radarAlt: 200 }),
      false
    );
    assert.equal(
      missedApproachCandidate(basePrev, { ...climbCurr, verticalSpeed: 2.1, aslAlt: 200, radarAlt: 200 }),
      true
    );
  });

  it("fires on altitude gain even without strong climb rate", () => {
    assert.equal(
      missedApproachCandidate(basePrev, {
        ...climbCurr,
        verticalSpeed: 0,
        aslAlt: 208,
        radarAlt: 208
      }),
      false
    );
    assert.equal(
      missedApproachCandidate(basePrev, {
        ...climbCurr,
        verticalSpeed: 0,
        aslAlt: 209,
        radarAlt: 209
      }),
      true
    );
  });
});

describe("isTouchdownTransition / isArrivalTouchdown", () => {
  it("requires previous airborne sample", () => {
    assert.equal(isTouchdownTransition(undefined, { situation: "LANDED" }), false);
  });

  it("requires an air-to-ground transition", () => {
    assert.equal(
      isTouchdownTransition({ situation: "FLYING" }, { situation: "FLYING" }),
      false
    );
    assert.equal(
      isTouchdownTransition({ situation: "LANDED" }, { situation: "LANDED" }),
      false
    );
  });

  it("detects grounded situations case-insensitively", () => {
    const prev = { situation: "flying", flightPhase: "LANDING" };
    assert.equal(isTouchdownTransition(prev, { situation: "landed" }), true);
    assert.equal(isTouchdownTransition(prev, { situation: "splashed down" }), true);
    assert.equal(isTouchdownTransition(prev, { situation: "prelanded" }), true);
  });

  it("matches plain touchdown when not in departure climb phase", () => {
    const prev = { situation: "FLYING", flightPhase: "LANDING" };
    const curr = { situation: "LANDED" };
    assert.equal(isTouchdownTransition(prev, curr), true);
    assert.equal(isArrivalTouchdown(prev, curr), true);
  });

  it("suppresses touchdown following takeoff/climb phase (pad hop)", () => {
    const prev = { situation: "FLYING", flightPhase: "TAKEOFF" };
    const curr = { situation: "LANDED" };
    assert.equal(isTouchdownTransition(prev, curr), true);
    assert.equal(isArrivalTouchdown(prev, curr), false);
  });

  it("still allows off-world style phases (e.g. CRUISE) for touchdown hooks", () => {
    const prev = { situation: "FLYING", flightPhase: "CRUISE" };
    const curr = { situation: "LANDED" };
    assert.equal(isArrivalTouchdown(prev, curr), true);
  });
});

describe("publisherDepartureClimbPhase", () => {
  it("detects TAKEOFF and CLIMB only", () => {
    assert.equal(publisherDepartureClimbPhase(undefined), false);
    assert.equal(publisherDepartureClimbPhase({ flightPhase: "TAKEOFF" }), true);
    assert.equal(publisherDepartureClimbPhase({ flightPhase: "initial_climb" }), true);
    assert.equal(publisherDepartureClimbPhase({ flightPhase: "TAXI" }), false);
  });
});
