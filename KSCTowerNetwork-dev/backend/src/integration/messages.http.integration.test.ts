/**
 * HTTP integration: full Express stack + Bearer JWT (same shape as web apiCall / KSP plugin).
 * Proves session ops chat and DM routes round-trip for two distinct principals.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "integration-test-secret-integration-test-secret";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { buildHttpApp, type BuiltHttpApp } from "../httpApp";
import { assignTower, createSession, ensureLocalRoleSeeded } from "../services/repository";
import { issueWebSessionToken } from "../services/webAuth";

let ctx: BuiltHttpApp;

before(async () => {
  ctx = await buildHttpApp();
});

after(() => {
  ctx.dispose();
});

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

describe("HTTP /v1/session/:id/messages (pilot + tower)", () => {
  it("POST from pilot then GET from tower sees the line; tower replies; pilot sees both", async () => {
    const pilotId = "http-int-pilot-1";
    const towerId = "http-int-tower-1";
    ensureLocalRoleSeeded(pilotId, "pilot");
    ensureLocalRoleSeeded(towerId, "controller");

    const session = await createSession(pilotId);
    const assigned = await assignTower(session.id, towerId);
    assert.equal(assigned?.assignedTowerUserId, towerId);

    const pilotTok = issueWebSessionToken(
      { userId: pilotId, email: "p1@int.test", role: "pilot" },
      "P1"
    );
    const towerTok = issueWebSessionToken(
      { userId: towerId, email: "t1@int.test", role: "controller" },
      "T1"
    );

    const sid = encodeURIComponent(session.id);

    const postP = await request(ctx.app)
      .post(`/v1/session/${sid}/messages`)
      .set(bearer(pilotTok))
      .send({ text: "from pilot" });
    assert.equal(postP.status, 201, JSON.stringify(postP.body));

    const getT = await request(ctx.app).get(`/v1/session/${sid}/messages`).set(bearer(towerTok));
    assert.equal(getT.status, 200, JSON.stringify(getT.body));
    const messagesT = getT.body.messages as Array<{ body: string; fromUserId: string }>;
    assert.ok(Array.isArray(messagesT));
    assert.ok(messagesT.some((m) => m.body === "from pilot" && m.fromUserId === pilotId));

    const postT = await request(ctx.app)
      .post(`/v1/session/${sid}/messages`)
      .set(bearer(towerTok))
      .send({ text: "from tower" });
    assert.equal(postT.status, 201, JSON.stringify(postT.body));

    const getP = await request(ctx.app).get(`/v1/session/${sid}/messages`).set(bearer(pilotTok));
    assert.equal(getP.status, 200, JSON.stringify(getP.body));
    const messagesP = getP.body.messages as Array<{ body: string }>;
    assert.ok(messagesP.some((m) => m.body === "from tower"));
    assert.ok(messagesP.some((m) => m.body === "from pilot"));
  });
});

describe("HTTP /v1/dm/:peer/messages (room co-participants)", () => {
  it("POST A→B then GET B inbox includes the line (peer not in WEB_LOGIN_USERS_JSON)", async () => {
    const a = "http-dm-a-1";
    const b = "http-dm-b-1";
    ensureLocalRoleSeeded(a, "pilot");
    ensureLocalRoleSeeded(b, "controller");
    const session = await createSession(a);
    await assignTower(session.id, b);

    const tokA = issueWebSessionToken({ userId: a, email: "a@int.test", role: "pilot" }, "A");
    const tokB = issueWebSessionToken({ userId: b, email: "b@int.test", role: "controller" }, "B");

    const peerB = encodeURIComponent(b);
    const post = await request(ctx.app)
      .post(`/v1/dm/${peerB}/messages`)
      .set(bearer(tokA))
      .send({ text: "dm from A" });
    assert.equal(post.status, 201, JSON.stringify(post.body));

    const peerA = encodeURIComponent(a);
    const get = await request(ctx.app).get(`/v1/dm/${peerA}/messages`).set(bearer(tokB));
    assert.equal(get.status, 200, JSON.stringify(get.body));
    const messages = get.body.messages as Array<{ body: string; fromUserId: string }>;
    assert.ok(messages.some((m) => m.body === "dm from A" && m.fromUserId === a));
  });
});
