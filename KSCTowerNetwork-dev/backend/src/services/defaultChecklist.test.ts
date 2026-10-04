/**
 * Default checklist IDs must stay stable vs web + plugin (sessions.checklist_state keys).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CHECKLIST_PHASES } from "./defaultChecklist";

describe("DEFAULT_CHECKLIST_PHASES", () => {
  it("has unique phase ids", () => {
    const ids = DEFAULT_CHECKLIST_PHASES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("has globally unique item ids across pilot + controller", () => {
    const seen = new Set<string>();
    for (const ph of DEFAULT_CHECKLIST_PHASES) {
      for (const it of ph.pilot) {
        assert.equal(seen.has(it.id), false, `duplicate item id: ${it.id}`);
        seen.add(it.id);
      }
      for (const it of ph.controller) {
        assert.equal(seen.has(it.id), false, `duplicate item id: ${it.id}`);
        seen.add(it.id);
      }
    }
  });

  it("every phase has at least one pilot and one controller line", () => {
    for (const ph of DEFAULT_CHECKLIST_PHASES) {
      assert.ok(ph.pilot.length > 0, `phase ${ph.id} pilot empty`);
      assert.ok(ph.controller.length > 0, `phase ${ph.id} controller empty`);
    }
  });
});
