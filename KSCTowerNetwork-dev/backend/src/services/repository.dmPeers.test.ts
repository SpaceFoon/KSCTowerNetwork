/**
 * DM peer directory must include tower session co-participants so POST /v1/dm/:peer/messages
 * does not 404 when pilot and controller only share a room (not WEB_LOGIN_USERS_JSON).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coParticipantUserIdsFromSessions, type SessionRecord } from "./repository";

const iso = "2026-01-01T00:00:00.000Z";

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, "id" | "pilotUserId">): SessionRecord {
  return {
    status: "assigned",
    createdAt: iso,
    updatedAt: iso,
    blockedUserIds: [],
    spectatorUserIds: [],
    ...partial
  };
}

describe("coParticipantUserIdsFromSessions", () => {
  it("returns pilot and spectators when caller is assigned tower", () => {
    const s: SessionRecord[] = [
      session({
        id: "room-a",
        pilotUserId: "user_pilot",
        assignedTowerUserId: "user_tower",
        spectatorUserIds: ["user_spec"]
      })
    ];
    const ids = coParticipantUserIdsFromSessions("user_tower", s).sort();
    assert.deepEqual(ids, ["user_pilot", "user_spec"].sort());
  });

  it("returns tower and spectators when caller is pilot", () => {
    const s: SessionRecord[] = [
      session({
        id: "room-b",
        pilotUserId: "p1",
        assignedTowerUserId: "t1",
        spectatorUserIds: ["s1", "s2"]
      })
    ];
    const ids = coParticipantUserIdsFromSessions("p1", s).sort();
    assert.deepEqual(ids, ["s1", "s2", "t1"].sort());
  });

  it("ignores closed sessions", () => {
    const s: SessionRecord[] = [
      session({
        id: "closed-room",
        pilotUserId: "p1",
        assignedTowerUserId: "t1",
        status: "closed"
      })
    ];
    assert.deepEqual(coParticipantUserIdsFromSessions("p1", s), []);
  });

  it("skips server radio owner id (system:radio)", () => {
    const s: SessionRecord[] = [
      session({
        id: "radio-room",
        pilotUserId: "system:radio",
        assignedTowerUserId: "human_tower"
      })
    ];
    const fromTower = coParticipantUserIdsFromSessions("human_tower", s);
    assert.deepEqual(fromTower, []);
  });
});
