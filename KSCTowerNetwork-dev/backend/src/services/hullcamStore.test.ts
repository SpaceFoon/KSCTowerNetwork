/**
 * HullCam frame store + KSC tower view-stream session id gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dropSession,
  getFrame,
  HULLCAM_STALE_MS,
  isKscTowerSessionId,
  listActiveSessionIds,
  listCameras,
  putFrame
} from "./hullcamStore";

describe("isKscTowerSessionId", () => {
  it("accepts the documented KSC-TOWER-* pattern", () => {
    assert.equal(isKscTowerSessionId("KSC-TOWER-pilot1"), true);
    assert.equal(isKscTowerSessionId("KSC-TOWER-ab_12"), true);
  });

  it("rejects wrong prefix, length, or characters", () => {
    assert.equal(isKscTowerSessionId("ksc-tOWER-x"), false);
    assert.equal(isKscTowerSessionId("KSC-TOWER-"), false);
    assert.equal(isKscTowerSessionId("KSC-TOWER-" + "a".repeat(41)), false);
    assert.equal(isKscTowerSessionId("session-normal"), false);
  });
});

describe("putFrame / getFrame / listCameras", () => {
  const sid = () => `hc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("stores JPEG bytes and retrieves while fresh", () => {
    const id = sid();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    putFrame(id, 0, "Cam A", jpeg);
    const fr = getFrame(id, 0);
    assert.ok(fr);
    assert.deepEqual(fr!.jpeg, jpeg);
    assert.equal(fr!.name, "Cam A");
    const cams = listCameras(id);
    assert.equal(cams.length, 1);
    assert.equal(cams[0]!.id, 0);
    dropSession(id);
  });

  it("lists active sessions with optional prefix", () => {
    const id = sid();
    putFrame(id, 1, "B", Buffer.from([0xff, 0xd8, 0xd9]));
    const all = listActiveSessionIds();
    assert.ok(all.includes(id));
    assert.ok(listActiveSessionIds("hc-").every((s) => s.startsWith("hc-")));
    dropSession(id);
  });

  it("getFrame returns null after stale window", (t) => {
    const id = sid();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    t.mock.timers.enable({ apis: ["Date"] });
    const start = 3_000_000_000_000;
    t.mock.timers.setTime(start);
    putFrame(id, 0, "C", jpeg);
    assert.ok(getFrame(id, 0));
    t.mock.timers.setTime(start + HULLCAM_STALE_MS + 1);
    assert.equal(getFrame(id, 0), null);
    t.mock.timers.reset();
    dropSession(id);
  });
});
