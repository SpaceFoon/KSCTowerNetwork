import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  pushViolationEvent,
  resetViolationsForTests,
  shouldEmitViolation,
  violationDisplayLine,
  type ViolationKind
} from "./violations";

const KINDS: ViolationKind[] = [
  "LANDING_NO_CLEARANCE",
  "RWY_INCURSION",
  "LOSS_OF_SEPARATION",
  "WRONG_RUNWAY"
];

describe("violationDisplayLine", () => {
  it("maps each kind to a distinct tower line", () => {
    assert.equal(violationDisplayLine("LANDING_NO_CLEARANCE"), "VIOLATION: LANDING WITHOUT CLEARANCE");
    assert.equal(violationDisplayLine("RWY_INCURSION"), "VIOLATION: RWY INCURSION");
    assert.equal(violationDisplayLine("LOSS_OF_SEPARATION"), "VIOLATION: LOSS OF SEPARATION");
    assert.equal(violationDisplayLine("WRONG_RUNWAY"), "VIOLATION: WRONG RUNWAY");
  });
});

describe("shouldEmitViolation / pushViolationEvent", () => {
  beforeEach(() => {
    resetViolationsForTests();
  });

  it("allows the first emission and dedupes within 45s", () => {
    assert.equal(shouldEmitViolation("s1", "RWY_INCURSION", 1000), true);
    assert.equal(shouldEmitViolation("s1", "RWY_INCURSION", 10_000), false);
    assert.equal(shouldEmitViolation("s1", "RWY_INCURSION", 45_999), false);
  });

  it("allows emission exactly at the dedupe boundary", () => {
    assert.equal(shouldEmitViolation("s2", "RWY_INCURSION", 1000), true);
    assert.equal(shouldEmitViolation("s2", "RWY_INCURSION", 46_000), true);
  });

  it("dedupes per kind, not across kinds", () => {
    assert.equal(shouldEmitViolation("s1", "RWY_INCURSION", 1000), true);
    assert.equal(shouldEmitViolation("s1", "WRONG_RUNWAY", 2000), true);
  });

  it("returns null from pushViolationEvent when deduped", () => {
    assert.ok(pushViolationEvent("s1", "LOSS_OF_SEPARATION", 1000, "detail"));
    assert.equal(pushViolationEvent("s1", "LOSS_OF_SEPARATION", 2000), null);
  });

  it("returns a populated event on first push", () => {
    const ev = pushViolationEvent("s2", "LANDING_NO_CLEARANCE", 5000, "no clearance");
    assert.ok(ev);
    assert.equal(ev?.sessionId, "s2");
    assert.equal(ev?.kind, "LANDING_NO_CLEARANCE");
    assert.equal(ev?.detail, "no clearance");
    assert.equal(ev?.at, new Date(5000).toISOString());
    assert.match(ev?.id ?? "", /^[0-9a-f-]{36}$/i);
  });

  it("covers every violation kind at least once", () => {
    for (const kind of KINDS) {
      resetViolationsForTests();
      const ev = pushViolationEvent(`sess-${kind}`, kind, 1000);
      assert.equal(ev?.kind, kind);
    }
  });
});
