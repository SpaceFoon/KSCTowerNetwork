/**
 * Vessel parts manifest hot store — LRU-ish cap and idle TTL.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dropManifest,
  getManifest,
  putManifest,
  VESSEL_MANIFEST_IDLE_TTL_MS
} from "./vesselManifestStore";

describe("vesselManifestStore", () => {
  it("put/get round-trip and tracks approxBytes", () => {
    const sid = `vm-${Date.now()}-a`;
    const payload = { parts: [{ i: 0, name: "Mk2", parent: -1 }], rootPartIndex: 0 };
    putManifest(sid, payload);
    const got = getManifest(sid);
    assert.ok(got);
    assert.deepEqual(got!.json, payload);
    assert.ok(got!.approxBytes > 0);
  });

  it("dropManifest removes the session", () => {
    const sid = `vm-${Date.now()}-b`;
    putManifest(sid, { x: 1 });
    dropManifest(sid);
    assert.equal(getManifest(sid), null);
  });

  it("returns null after idle TTL", (t) => {
    const sid = `vm-${Date.now()}-ttl`;
    t.mock.timers.enable({ apis: ["Date"] });
    const start = 2_000_000_000_000;
    t.mock.timers.setTime(start);
    putManifest(sid, { ok: true });
    assert.ok(getManifest(sid));
    t.mock.timers.setTime(start + VESSEL_MANIFEST_IDLE_TTL_MS + 1);
    assert.equal(getManifest(sid), null);
    t.mock.timers.reset();
  });
});
