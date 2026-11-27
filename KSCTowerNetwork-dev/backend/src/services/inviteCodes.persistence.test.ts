/**
 * An invite that cannot be written to disk must not be handed out: the use or the new code
 * would otherwise exist only in memory and disappear on restart. Own file because the store
 * path is read at import, and this one points somewhere that cannot be written.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "invite-persist-secret-value-0123456789abcdef";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("createInviteCode rejects when the store cannot be written, and keeps no unsaved code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ksc-invite-"));
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  process.env.INVITE_CODES_PATH = path.join(blocker, "codes.json");
  const invites = await import("./inviteCodes");

  await assert.rejects(invites.createInviteCode({ createdByUserId: "rv-owner", maxUses: 1 }));
  assert.deepEqual(invites.listInviteCodes(), []);
});
