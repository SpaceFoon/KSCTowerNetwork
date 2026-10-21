/**
 * Unit tests for the dev-mode identity bridge in `requireAuth`.
 *
 * The bridge fixes a bug where the in-game KSP plugin (authed as a real
 * `plugin_session` JWT) and the player's web browser (no credential, dev
 * open-auth stamps `DEV_USER_ID`) saw different `userId`s — so `/me/active-room`
 * never recognized the room the plugin had created. After the bridge, a
 * credential-less browser request from the same IP inherits the plugin's
 * userId.
 *
 * Set env BEFORE importing config/env (which freezes via z.parse at import
 * time). Same trick used by repository.test.ts.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "development";
process.env.DEV_OPEN_AUTH = "1";
process.env.DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN = "1";

import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { env } from "../config/env";
import {
  requireAuth,
  requireRole,
  requireCapability,
  __resetPluginIdentityBridgeForTests
} from "./auth";
import { banUser, ensureLocalRoleSeeded, unbanUser } from "../services/repository";

// Auth fixtures explicitly enable the dev identity bridge; personal dotenv files stay unloaded.
env.DEV_OPEN_AUTH = true;
env.DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN = true;
const SIGNING_SECRET = env.APP_JWT_SECRET;
const DEV_USER_ID = env.DEV_USER_ID;

type AuthShape = {
  userId: string;
  tokenType?: string;
  authSource?: string;
  ip?: string;
};

type FakeReq = {
  ip: string;
  socket: { remoteAddress?: string };
  headers: Record<string, string>;
  cookies: Record<string, string>;
  header(name: string): string | undefined;
  auth?: AuthShape;
};

function makeReq(opts: { ip: string; bearer?: string } = { ip: "127.0.0.1" }): FakeReq {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = "Bearer " + opts.bearer;
  return {
    ip: opts.ip,
    socket: { remoteAddress: opts.ip },
    headers,
    cookies: {},
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  };
}

async function runRequireAuth(req: FakeReq): Promise<{
  status: number;
  body: unknown;
  nexted: boolean;
}> {
  let status = 200;
  let body: unknown = undefined;
  let nexted = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    }
  };
  await requireAuth(req as never, res as never, () => {
    nexted = true;
  });
  return { status, body, nexted };
}

async function runGate(
  gate: (req: never, res: never, next: () => void) => Promise<void>,
  req: FakeReq
): Promise<{ status: number; body: unknown; nexted: boolean }> {
  let status = 200;
  let body: unknown = undefined;
  let nexted = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    }
  };
  await gate(req as never, res as never, () => {
    nexted = true;
  });
  return { status, body, nexted };
}

function makePluginJwt(sub: string): string {
  return jwt.sign({ sub, token_type: "plugin_session" }, SIGNING_SECRET, { expiresIn: "1h" });
}

test.beforeEach(() => {
  __resetPluginIdentityBridgeForTests();
});

test("dev open-auth without credential stamps DEV_USER_ID by default", async () => {
  const req = makeReq({ ip: "10.0.0.10" });
  const result = await runRequireAuth(req);
  assert.equal(result.nexted, true);
  assert.equal(req.auth?.userId, DEV_USER_ID);
  assert.equal(req.auth?.authSource, "dev-open");
});

test("plugin_session JWT under dev open-auth keeps its real userId", async () => {
  const token = makePluginJwt("user-pilot-real");
  const req = makeReq({ ip: "10.0.0.20", bearer: token });
  const result = await runRequireAuth(req);
  assert.equal(result.nexted, true);
  assert.equal(req.auth?.userId, "user-pilot-real");
  assert.equal(req.auth?.tokenType, "plugin");
  assert.equal(req.auth?.authSource, "bearer");
});

test("subsequent credential-less request from the same IP inherits the plugin userId", async () => {
  const token = makePluginJwt("user-pilot-real");

  // First the plugin authenticates — this primes the bridge for 10.0.0.30.
  const pluginReq = makeReq({ ip: "10.0.0.30", bearer: token });
  await runRequireAuth(pluginReq);
  assert.equal(pluginReq.auth?.userId, "user-pilot-real");

  // Then the same machine's browser (no creds) hits the API.
  const browserReq = makeReq({ ip: "10.0.0.30" });
  const result = await runRequireAuth(browserReq);
  assert.equal(result.nexted, true);
  assert.equal(browserReq.auth?.userId, "user-pilot-real");
  assert.equal(browserReq.auth?.authSource, "dev-open-bridged");
});

test("identity bridge does NOT cross IPs", async () => {
  const token = makePluginJwt("user-pilot-real");

  const pluginReq = makeReq({ ip: "10.0.0.40", bearer: token });
  await runRequireAuth(pluginReq);

  const otherIpReq = makeReq({ ip: "10.0.0.41" });
  await runRequireAuth(otherIpReq);
  assert.equal(otherIpReq.auth?.userId, DEV_USER_ID);
  assert.equal(otherIpReq.auth?.authSource, "dev-open");
});

test("banned mod cannot pass role or capability gates", async () => {
  const userId = "banned-moderator-test";
  ensureLocalRoleSeeded(userId, "mod");
  await banUser(userId, "test-owner");
  const req = makeReq({ ip: "10.0.0.50" });
  req.auth = { userId, tokenType: "clerk", authSource: "bearer", ip: req.ip };

  try {
    const roleResult = await runGate(requireRole("mod"), req);
    assert.equal(roleResult.status, 403);
    assert.deepEqual(roleResult.body, { error: "Banned", reason: "banned" });
    assert.equal(roleResult.nexted, false);

    const capabilityResult = await runGate(requireCapability("mod:ban_temp"), req);
    assert.equal(capabilityResult.status, 403);
    assert.deepEqual(capabilityResult.body, { error: "Banned", reason: "banned" });
    assert.equal(capabilityResult.nexted, false);
  } finally {
    await unbanUser(userId, "test-owner");
  }
});
