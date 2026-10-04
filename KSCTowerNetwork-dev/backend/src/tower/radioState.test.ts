import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SessionRecord } from "../services/repository";
import { resetRadioStateForTests, updateRadioStateForTelemetry } from "./radioState";

function session(id: string, callsign: string): SessionRecord {
  const now = new Date(0).toISOString();
  return {
    id,
    pilotUserId: `${id}-pilot`,
    status: "active",
    createdAt: now,
    updatedAt: now,
    blockedUserIds: [],
    spectatorUserIds: [],
    callsign
  };
}

describe("radioState", () => {
  beforeEach(() => {
    resetRadioStateForTests();
  });

  it("returns undefined when no frequency is tuned", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    assert.equal(state, undefined);
  });

  it("marks a transmitting session busy on its tuned frequency", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );

    assert.equal(state?.busy, true);
    assert.equal(state?.blocked, false);
    assert.equal(state?.transmitterSessionId, "alpha");
    assert.equal(state?.transmitterCallsign, "ALPHA");
    assert.equal(state?.message, "FREQ BUSY");
    assert.equal(state?.freqMhz, 118.025);
    assert.equal(state?.expiresAtMs, 3500);
  });

  it("reports blocked when another session keys over an active transmitter", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );

    const state = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );

    assert.equal(state?.busy, true);
    assert.equal(state?.blocked, true);
    assert.equal(state?.transmitterSessionId, "alpha");
    assert.equal(state?.blockedBySessionId, "bravo");
    assert.equal(state?.blockedWithSessionId, "alpha");
    assert.equal(state?.message, "BLOCKED - SAY AGAIN");
  });

  it("dedupes repeated block events within 4s", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );
    const second = updateRadioStateForTelemetry(
      "bravo",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      2000
    );
    assert.equal(second?.blocked, true);
    assert.equal(second?.blockedAtMs, 1500);
  });

  it("releases the channel when PTT drops", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );

    const state = updateRadioStateForTelemetry(
      "alpha",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: false },
      session("alpha", "ALPHA"),
      1200
    );

    assert.equal(state?.busy, false);
    assert.equal(state?.blocked, false);
    assert.equal(state?.message, undefined);
  });

  it("clears prior channel when the session retunes", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );

    updateRadioStateForTelemetry(
      "alpha",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 121.5, radioPtt: true },
      session("alpha", "ALPHA"),
      1500
    );

    const oldChannel = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1600
    );
    assert.equal(oldChannel?.busy, true);
    assert.equal(oldChannel?.blocked, false);
    assert.equal(oldChannel?.transmitterSessionId, "bravo");
  });

  it("expires stale transmitters after 2.5s", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );

    const state = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: false },
      session("bravo", "BRAVO"),
      3501
    );

    assert.equal(state?.busy, false);
    assert.equal(state?.blocked, false);
  });

  it("uses telemetry callsign when session callsign is blank", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true, callsign: "  NOVA  " },
      session("alpha", "  "),
      1000
    );
    assert.equal(state?.transmitterCallsign, "NOVA");
  });

  it("returns undefined when radioFreqMhz is not a finite number", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: Number.NaN, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    assert.equal(state, undefined);
  });

  it("snaps nearby frequencies to the same 25 kHz channel", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.024, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    const state = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.026, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );
    assert.equal(state?.blocked, true);
    assert.equal(state?.transmitterSessionId, "alpha");
  });

  it("keeps busy state until the 2.5s hold fully elapses", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    const stillBusy = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: false },
      session("bravo", "BRAVO"),
      3500
    );
    assert.equal(stillBusy?.busy, true);
  });

  it("expires blocked state after 6s", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );
    const cleared = updateRadioStateForTelemetry(
      "bravo",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: false },
      session("bravo", "BRAVO"),
      7501
    );
    assert.equal(cleared?.blocked, false);
  });

  it("allows a new block after dedupe window expires", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );
    updateRadioStateForTelemetry(
      "alpha",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: false },
      session("alpha", "ALPHA"),
      4000
    );
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      5000
    );
    const secondBlock = updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      5600
    );
    assert.equal(secondBlock?.blocked, true);
    assert.equal(secondBlock?.blockedAtMs, 5600);
  });

  it("marks the incumbent transmitter blocked when doubled up", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    updateRadioStateForTelemetry(
      "bravo",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("bravo", "BRAVO"),
      1500
    );
    const alphaView = updateRadioStateForTelemetry(
      "alpha",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1600
    );
    assert.equal(alphaView?.blocked, true);
    assert.equal(alphaView?.blockedBySessionId, "bravo");
    assert.equal(alphaView?.blockedWithSessionId, "alpha");
  });

  it("does not treat a quiet tail as blocking when the channel is idle", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: false },
      session("alpha", "ALPHA"),
      1000
    );
    assert.equal(state?.busy, false);
    assert.equal(state?.blocked, false);
    assert.equal(state?.message, undefined);
  });

  it("continues an existing transmission without resetting startedAtMs", () => {
    updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1000
    );
    const continued = updateRadioStateForTelemetry(
      "alpha",
      { radioFreqMhz: 118.025, radioPtt: true },
      { radioFreqMhz: 118.025, radioPtt: true },
      session("alpha", "ALPHA"),
      1500
    );
    assert.equal(continued?.startedAtMs, 1000);
    assert.equal(continued?.updatedAtMs, 1500);
  });

  it("falls back to pilotName when callsign fields are blank", () => {
    const state = updateRadioStateForTelemetry(
      "alpha",
      undefined,
      { radioFreqMhz: 118.025, radioPtt: true, pilotName: "Bill" },
      session("alpha", ""),
      1000
    );
    assert.equal(state?.transmitterCallsign, "Bill");
  });
});
