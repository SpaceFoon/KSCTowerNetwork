/**
 * HTTP checks for the open items from the 2026-10-24 review, through the full Express stack
 * with real bearer tokens: ban gates on session-control routes, the score roster rule, the
 * single-winner tower claim, and the live socket path advertised by site info.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "review-open-items-http-secret-value-0123456789";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { buildHttpApp, type BuiltHttpApp } from "../httpApp";
import {
  assignTower,
  banUser,
  createSession,
  ensureLocalRoleSeeded
} from "../services/repository";
import { issueWebSessionToken } from "../services/webAuth";

let ctx: BuiltHttpApp;

before(async () => {
  ctx = await buildHttpApp();
});

after(() => {
  ctx.dispose();
});

function tokenFor(userId: string, role: "pilot" | "controller" | "mod"): string {
  ensureLocalRoleSeeded(userId, role);
  return issueWebSessionToken({ userId, email: `${userId}@review.test`, role }, userId);
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

describe("banned pilots are refused on session-control and publish routes", () => {
  it("rejects rename, telemetry and rotation for a banned pilot in their own room", async () => {
    const pilotId = "rv-http-banned-pilot";
    const session = await createSession(pilotId);
    const sid = encodeURIComponent(session.id);
    const pilotTok = tokenFor(pilotId, "pilot");

    await banUser(pilotId, "rv-http-supermod");

    const rename = await request(ctx.app)
      .patch(`/v1/session/${sid}`)
      .set(bearer(pilotTok))
      .send({ name: "still mine" });
    assert.equal(rename.status, 403, JSON.stringify(rename.body));
    assert.equal(rename.body.reason, "banned");

    const telemetry = await request(ctx.app)
      .post(`/v1/telemetry/${sid}`)
      .set(bearer(pilotTok))
      .send({});
    assert.equal(telemetry.status, 403, JSON.stringify(telemetry.body));
    assert.equal(telemetry.body.reason, "banned");

    const rotate = await request(ctx.app)
      .post(`/v1/session/${sid}/next-tower`)
      .set(bearer(pilotTok))
      .send({});
    assert.equal(rotate.status, 403, JSON.stringify(rotate.body));
    assert.equal(rotate.body.reason, "banned");
  });
});

describe("controller scores must target someone in the room", () => {
  it("refuses a target outside the room and accepts the pilot", async () => {
    const pilotId = "rv-http-score-pilot";
    const towerId = "rv-http-score-tower";
    const session = await createSession(pilotId);
    await assignTower(session.id, towerId);
    const sid = encodeURIComponent(session.id);
    const towerTok = tokenFor(towerId, "controller");

    const stranger = await request(ctx.app)
      .post(`/v1/session/${sid}/score`)
      .set(bearer(towerTok))
      .send({ targetUserId: "rv-http-unrelated-account", kind: "controller_reward", points: 5, label: "x" });
    assert.equal(stranger.status, 400, JSON.stringify(stranger.body));
    assert.equal(stranger.body.reason, "score_target_not_in_session");

    const pilot = await request(ctx.app)
      .post(`/v1/session/${sid}/score`)
      .set(bearer(towerTok))
      .send({ targetUserId: pilotId, kind: "controller_reward", points: 5, label: "good call" });
    assert.equal(pilot.status, 201, JSON.stringify(pilot.body));
  });
});

describe("tower seat claims have a single winner", () => {
  it("lets exactly one of two concurrent claims take a vacant seat", async () => {
    const pilotId = "rv-http-claim-pilot";
    const session = await createSession(pilotId);
    const sid = encodeURIComponent(session.id);
    const modA = tokenFor("rv-http-claim-mod-a", "mod");
    const modB = tokenFor("rv-http-claim-mod-b", "mod");

    const [a, b] = await Promise.all([
      request(ctx.app).post(`/v1/session/${sid}/claim-tower`).set(bearer(modA)).send({}),
      request(ctx.app).post(`/v1/session/${sid}/claim-tower`).set(bearer(modB)).send({})
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.reason, "seat_taken");
  });
});

describe("site info advertises the live socket path", () => {
  it("reports the configured WebSocket path", async () => {
    const res = await request(ctx.app).get("/v1/site/info");
    assert.equal(res.status, 200);
    assert.equal(res.body.live?.wsPath, "/v1/live/ws");
  });
});
