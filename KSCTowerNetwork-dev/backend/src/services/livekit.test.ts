/**
 * LiveKit helpers: bridge identity classification + JWT video grants for tokens.
 *
 * Token shape assertions use `jwt.decode` (no verify) so tests work with whatever
 * LIVEKIT_* values `.env.development` provides. `t.skip()` when LiveKit is unset.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";

import { env } from "../config/env";
import {
  bridgeDisplayName,
  isBridgeIdentity,
  isLiveKitConfigured,
  issueLiveKitToken,
  listBridgeIdentities
} from "./livekit";

type VideoGrant = {
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
};

function decodeJwtPayload(token: string): { sub: string; video: VideoGrant; name?: string; metadata?: string } {
  const d = jwt.decode(token);
  assert.ok(d && typeof d === "object" && "video" in d);
  return d as { sub: string; video: VideoGrant; name?: string; metadata?: string };
}

describe("isBridgeIdentity / listBridgeIdentities", () => {
  it("treats configured bridge ids as non-human", () => {
    const ids = listBridgeIdentities();
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.equal(isBridgeIdentity(id), true);
    }
    assert.equal(isBridgeIdentity("user_clerk_abc"), false);
    assert.equal(isBridgeIdentity(""), false);
  });
});

describe("bridgeDisplayName", () => {
  it("returns a non-empty display string", () => {
    const s = bridgeDisplayName();
    assert.ok(typeof s === "string" && s.length > 0);
  });
});

describe("issueLiveKitToken JWT video grant", () => {
  it("ksp_bridge token pins tower room and grants publish + subscribe", async (t) => {
    if (!isLiveKitConfigured()) {
      t.skip();
      return;
    }
    const { token } = await issueLiveKitToken({
      userId: "ksp_bridge",
      roomName: "tower-sess-xyz",
      canPublish: true,
      canSubscribe: true
    });
    const p = decodeJwtPayload(token);
    assert.equal(p.sub, "ksp_bridge");
    assert.equal(p.video.room, "tower-sess-xyz");
    assert.equal(p.video.roomJoin, true);
    assert.equal(p.video.canPublish, true);
    assert.equal(p.video.canSubscribe, true);
    assert.equal(p.name, bridgeDisplayName());
    assert.ok(p.metadata?.includes("ksp_voice_bridge"));
  });

  it("human pilot token uses displayName and omits bridge metadata", async (t) => {
    if (!isLiveKitConfigured()) {
      t.skip();
      return;
    }
    const { token } = await issueLiveKitToken({
      userId: "user_pilot_99",
      roomName: "tower-room-1",
      canPublish: true,
      canSubscribe: true,
      displayName: "Jebediah"
    });
    const p = decodeJwtPayload(token);
    assert.equal(p.sub, "user_pilot_99");
    assert.equal(p.video.room, "tower-room-1");
    assert.equal(p.name, "Jebediah");
    assert.equal(p.metadata, undefined);
  });

  it("subscribe-only grant sets canPublish false", async (t) => {
    if (!isLiveKitConfigured()) {
      t.skip();
      return;
    }
    const { token } = await issueLiveKitToken({
      userId: "listener_1",
      roomName: "tower-room-2",
      canPublish: false,
      canSubscribe: true
    });
    const p = decodeJwtPayload(token);
    assert.equal(p.video.canPublish, false);
    assert.equal(p.video.canSubscribe, true);
  });

  it("JWT iss matches configured LIVEKIT_API_KEY (proves signing context)", async (t) => {
    if (!isLiveKitConfigured()) {
      t.skip();
      return;
    }
    const { token } = await issueLiveKitToken({
      userId: "jwt_iss_probe",
      roomName: "tower-room-iss",
      canPublish: false,
      canSubscribe: true
    });
    const raw = jwt.decode(token);
    assert.ok(raw && typeof raw === "object" && "iss" in raw);
    assert.equal((raw as { iss?: string }).iss, env.LIVEKIT_API_KEY);
  });
});
