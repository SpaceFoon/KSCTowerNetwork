process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.DEV_OPEN_AUTH = "0";
process.env.ATIS_LIVE_WEATHER = "false";
process.env.APP_JWT_SECRET = "thumbnail-integration-secret-thumbnail-integration-secret";

import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import request from "supertest";
import sharp from "sharp";
import { buildHttpApp, type BuiltHttpApp } from "../httpApp";
import { createSession, setTelemetry, ensureLocalRoleSeeded, closeSession } from "../services/repository";
import { issueWebSessionToken } from "../services/webAuth";
import { getCraftThumbnail, putCraftThumbnail } from "../services/craftThumbnailStore";
import { markDbUnavailable } from "../lib/db";
import { markRedisUnavailable } from "../lib/redis";

let ctx: BuiltHttpApp;
before(async () => { ctx = await buildHttpApp(); });
after(async () => { ctx.dispose(); await markDbUnavailable(new Error("Test cleanup")); markRedisUnavailable(new Error("Test cleanup")); });

it("only the pilot publishes; controllers read PNGs; wrong craft, corrupt data and closed sessions are rejected", async () => {
  const identities = ["thumb-pilot", "thumb-controller", "thumb-stranger"];
  identities.forEach((id, i) => ensureLocalRoleSeeded(id, i === 1 ? "controller" : "pilot"));
  const tokens = identities.map((userId, i) => issueWebSessionToken({ userId, email: `${userId}@test.local`, role: i === 1 ? "controller" : "pilot" }, userId));
  const session = await createSession(identities[0]!);
  await setTelemetry(session.id, { craftName: "Test craft" });
  const url = `/v1/craft-thumbnail/${encodeURIComponent(session.id)}`;
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#00cddd" } }).png().toBuffer();
  const upload = (token: string, bytes: Buffer, name = "Test craft") => request(ctx.app).post(url).auth(token, { type: "bearer" }).set("Content-Type", "image/png").set("x-craft-name", encodeURIComponent(name)).send(bytes);
  assert.equal((await upload(tokens[1]!, png)).status, 403);
  assert.equal((await upload(tokens[0]!, png, "Different craft")).status, 409);
  assert.equal((await upload(tokens[0]!, Buffer.from("invalid"))).status, 400);
  assert.equal((await upload(tokens[0]!, Buffer.alloc(257 * 1024))).status, 413);
  assert.equal((await upload(tokens[0]!, png)).status, 200);
  const image = await request(ctx.app).get(`${url}?craftName=Test%20craft`).auth(tokens[1]!, { type: "bearer" });
  assert.equal(image.status, 200);
  assert.match(image.headers["content-type"]!, /image\/png/);
  assert.match(image.headers["cache-control"]!, /no-store/);
  assert.equal((await sharp(image.body).metadata()).width, 128);
  assert.equal((await request(ctx.app).get(`${url}?craftName=Test%20craft`).auth(tokens[2]!, { type: "bearer" })).status, 403);
  await setTelemetry(session.id, { craftName: "New craft" });
  assert.equal((await request(ctx.app).get(`${url}?craftName=Test%20craft`).auth(tokens[1]!, { type: "bearer" })).status, 404);
  await closeSession(session.id);
  assert.equal((await upload(tokens[0]!, png, "New craft")).status, 404);
});

it("expires thumbnails and refuses name mismatches", () => {
  putCraftThumbnail("ttl-test", "Alpha", Buffer.from("image"), 1000);
  assert.ok(getCraftThumbnail("ttl-test", "Alpha", 2000));
  assert.equal(getCraftThumbnail("ttl-test", "Beta", 2000), null);
  assert.equal(getCraftThumbnail("ttl-test", "Alpha", 302000), null);
});
