/**
 * Booth thread ids + LiveKit room naming — wired through voice + chat routes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boothLiveKitRoomName,
  boothThreadId,
  getSessionBoothMuted,
  isBoothThreadId,
  opsLiveKitRoomName,
  type SessionRecord
} from "./repository";

describe("boothThreadId / isBoothThreadId", () => {
  it("prefixes session id and detects booth threads", () => {
    assert.equal(boothThreadId("abc-123"), "booth:abc-123");
    assert.equal(isBoothThreadId("booth:abc-123"), true);
    assert.equal(isBoothThreadId("dm:a|b"), false);
  });

  it("requires non-empty sessionId", () => {
    assert.throws(() => boothThreadId(""), /required/);
  });
});

describe("boothLiveKitRoomName / opsLiveKitRoomName", () => {
  it("uses tower-{sessionId} with optional -booth suffix", () => {
    const sid = "dev-shared";
    assert.equal(opsLiveKitRoomName(sid), `tower-${sid}`);
    assert.equal(boothLiveKitRoomName(sid), `tower-${sid}-booth`);
  });

  it("maps server radio ops channels to the shared LiveKit room", () => {
    assert.equal(opsLiveKitRoomName("ksc-radio-twr"), "tower-ksc-radio-shared");
    assert.equal(boothLiveKitRoomName("ksc-radio-twr"), "tower-ksc-radio-twr-booth");
  });
});

describe("getSessionBoothMuted", () => {
  it("defaults false when missing or undefined session", () => {
    assert.equal(getSessionBoothMuted(undefined), false);
    assert.equal(getSessionBoothMuted(null), false);
    assert.equal(getSessionBoothMuted({ boothMuted: false } as SessionRecord), false);
    assert.equal(getSessionBoothMuted({ boothMuted: true } as SessionRecord), true);
  });
});
