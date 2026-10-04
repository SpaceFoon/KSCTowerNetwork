/**
 * In-memory LiveKit kick cooldowns gate `/livekit-token` reissue after a mod kick.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  clearKickCooldown,
  getKickCooldownRemainingSec,
  kickIdentityFromRoom,
  listKickCooldowns
} from "./livekit";

test("kickIdentityFromRoom records cooldown even when LiveKit API client is absent", async () => {
  const identity = `kick-cd-${randomUUID()}`;
  const roomName = `tower-${randomUUID()}`;
  assert.equal(clearKickCooldown(identity, roomName), 0);
  const { cooldownExpiresAtMs } = await kickIdentityFromRoom(identity, roomName, 90);
  const rem = getKickCooldownRemainingSec(identity, roomName);
  assert.ok(rem >= 89 && rem <= 90, `expected ~90s remaining, got ${rem}`);
  assert.ok(cooldownExpiresAtMs > Date.now());
  assert.equal(clearKickCooldown(identity, roomName), 1);
  assert.equal(getKickCooldownRemainingSec(identity, roomName), 0);
});

test("clearKickCooldown without roomName clears every cooldown row for that identity", async () => {
  const identity = `kick-multi-${randomUUID()}`;
  const r1 = `tower-${randomUUID()}`;
  const r2 = `tower-${randomUUID()}`;
  await kickIdentityFromRoom(identity, r1, 600);
  await kickIdentityFromRoom(identity, r2, 600);
  assert.ok(getKickCooldownRemainingSec(identity, r1) > 0);
  assert.ok(getKickCooldownRemainingSec(identity, r2) > 0);
  const rows = listKickCooldowns().filter((e) => e.identity === identity);
  assert.ok(rows.length >= 2);
  assert.equal(clearKickCooldown(identity), 2);
  assert.equal(getKickCooldownRemainingSec(identity, r1), 0);
  assert.equal(getKickCooldownRemainingSec(identity, r2), 0);
});
