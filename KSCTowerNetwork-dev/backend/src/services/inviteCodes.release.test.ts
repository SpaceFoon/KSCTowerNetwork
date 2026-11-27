/**
 * A signup that consumed an invite but minted no account gives the use back, so the invite
 * still works for the retry. Kept in its own file: the invite store path is read at import.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "invite-release-secret-value-0123456789abcdef";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("releaseInviteCode gives back the use taken by a signup that minted no account", async () => {
  process.env.INVITE_CODES_PATH = path.join(mkdtempSync(path.join(tmpdir(), "ksc-invite-")), "codes.json");
  const invites = await import("./inviteCodes");

  const invite = await invites.createInviteCode({ createdByUserId: "rv-owner", maxUses: 1 });
  assert.equal((await invites.consumeInviteCode(invite.code)).ok, true);
  assert.deepEqual(await invites.consumeInviteCode(invite.code), { ok: false, reason: "exhausted" });

  await invites.releaseInviteCode(invite.code);
  assert.equal((await invites.consumeInviteCode(invite.code)).ok, true);
});
