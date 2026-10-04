import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRequestedFrequencyMhz } from "../services/repository";
import { RADIO_QUICK_PRESETS } from "./radioPresets";

describe("RADIO_QUICK_PRESETS", () => {
  it("has unique ids and canonical six-digit MHz strings on the 25 kHz grid", () => {
    const ids = RADIO_QUICK_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of RADIO_QUICK_PRESETS) {
      assert.match(p.frequencyMhz, /^\d{3}\.\d{3}$/);
      assert.equal(
        normalizeRequestedFrequencyMhz(p.frequencyMhz),
        p.frequencyMhz,
        `preset ${p.id} frequency must be valid aviation-band MHz`
      );
    }
  });
});
