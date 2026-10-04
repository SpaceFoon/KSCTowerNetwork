/**
 * Pure helpers from repository.ts — lobby labels, DM ids, checklist wire validation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checklistSideComplete,
  defaultFrequencyMhz,
  defaultRoomName,
  disambiguateRoomName,
  dmThreadId,
  evaluateAutoRule,
  isDmParticipant,
  parseDmThreadId,
  sanitizeChecklistPhases,
  sanitizeRoomName,
  type ChecklistAutoRule,
  type ChecklistPhaseDef,
  type ChecklistState,
  type TelemetrySample
} from "./repository";

describe("defaultRoomName / defaultFrequencyMhz", () => {
  it("builds uppercased tower title with fallback callsign", () => {
    assert.equal(defaultRoomName("  foo  "), "FOO Tower");
    assert.equal(defaultRoomName(""), "TOWER Tower");
  });

  it("formats frequency as NNN.NNN in aviation band", () => {
    const s = defaultFrequencyMhz("session-abc-123");
    assert.match(s, /^\d{3}\.\d{3}$/);
    const n = Number(s);
    assert.ok(n >= 118 && n <= 136.975);
  });
});

describe("sanitizeRoomName", () => {
  it("strips controls, trims, caps length", () => {
    assert.equal(sanitizeRoomName("  hello\u0000 "), "hello");
    assert.equal(sanitizeRoomName(1), undefined);
    assert.equal(sanitizeRoomName("   "), undefined);
    const long = "x".repeat(100);
    assert.equal(sanitizeRoomName(long)?.length, 80);
  });
});

describe("disambiguateRoomName", () => {
  it("appends numeric suffix when base collides (case-insensitive)", () => {
    assert.equal(disambiguateRoomName("Stock", ["stock"]), "Stock 2");
    assert.equal(disambiguateRoomName("Stock", ["stock", "stock 2"]), "Stock 3");
  });
});

describe("dmThreadId / parseDmThreadId / isDmParticipant", () => {
  it("is symmetric and ordered low|high", () => {
    assert.equal(dmThreadId("b", "a"), "dm:a|b");
    assert.equal(dmThreadId("a", "b"), "dm:a|b");
  });

  it("throws on empty or self-DM", () => {
    assert.throws(() => dmThreadId("", "a"), /both userIds/);
    assert.throws(() => dmThreadId("a", "a"), /yourself/);
  });

  it("round-trips via parseDmThreadId", () => {
    const id = dmThreadId("user_lo", "user_hi");
    // Alphabetically: user_hi < user_lo → lo|hi order in the wire id.
    assert.deepEqual(parseDmThreadId(id), { lo: "user_hi", hi: "user_lo" });
    assert.equal(parseDmThreadId("not-dm"), null);
    assert.equal(parseDmThreadId("dm:nosep"), null);
  });

  it("isDmParticipant", () => {
    const id = dmThreadId("p1", "p2");
    assert.equal(isDmParticipant(id, "p1"), true);
    assert.equal(isDmParticipant(id, "p3"), false);
  });
});

describe("sanitizeChecklistPhases", () => {
  it("accepts a minimal valid phase list", () => {
    const out = sanitizeChecklistPhases([
      {
        id: "p1",
        title: "Phase 1",
        pilot: [{ id: "a1", label: "Do thing" }],
        controller: [{ id: "c1", label: "Tower thing" }]
      }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.pilot[0]!.label, "Do thing");
  });

  it("rejects duplicate phase ids", () => {
    assert.throws(
      () =>
        sanitizeChecklistPhases([
          { id: "same", title: "A", pilot: [], controller: [] },
          { id: "same", title: "B", pilot: [], controller: [] }
        ]),
      /duplicate phase id/
    );
  });
});

describe("evaluateAutoRule", () => {
  const rule = (expr: string): ChecklistAutoRule => ({ kind: "telemetry", expr });

  it("compares numeric telemetry fields", () => {
    const tel = { radarAlt: 150 } as TelemetrySample;
    assert.equal(evaluateAutoRule(rule("radarAlt > 100"), tel), true);
    assert.equal(evaluateAutoRule(rule("radarAlt < 100"), tel), false);
  });

  it("compares booleans", () => {
    const tel = { gearDown: true } as TelemetrySample;
    assert.equal(evaluateAutoRule(rule("gearDown == true"), tel), true);
    assert.equal(evaluateAutoRule(rule("gearDown == false"), tel), false);
  });

  it("returns false for bad expressions or missing telemetry", () => {
    assert.equal(evaluateAutoRule(rule("not a valid expr"), { radarAlt: 1 } as TelemetrySample), false);
    assert.equal(evaluateAutoRule(rule("radarAlt > 0"), undefined), false);
  });
});

describe("checklistSideComplete", () => {
  const tick = { doneAt: "2020-01-01T00:00:00.000Z", byUserId: "u1" };
  const phases: ChecklistPhaseDef[] = [
    {
      id: "p",
      title: "T",
      pilot: [{ id: "a", label: "x" }],
      controller: [{ id: "c", label: "y" }]
    }
  ];

  it("requires every item on the side ticked", () => {
    const st: ChecklistState = { pilot: { a: tick }, controller: {} };
    assert.equal(checklistSideComplete(phases, st, "pilot"), true);
    assert.equal(checklistSideComplete(phases, st, "controller"), false);
  });

  it("is false when there are zero items on that side", () => {
    const emptyPilot: ChecklistPhaseDef[] = [
      { id: "p", title: "T", pilot: [], controller: [{ id: "c", label: "y" }] }
    ];
    assert.equal(checklistSideComplete(emptyPilot, { pilot: {}, controller: {} }, "pilot"), false);
  });
});
