import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveKitTokenRequestUrl,
  parseSessionTuneCommand,
  readLiveKitTokenFromJsonBody
} from "../src/bridgeProtocol.js";

test("buildLiveKitTokenRequestUrl encodes session id and trims trailing slashes on api base", () => {
  assert.equal(
    buildLiveKitTokenRequestUrl("http://127.0.0.1:48787/v1/", "pilot/a"),
    "http://127.0.0.1:48787/v1/session/pilot%2Fa/livekit-token"
  );
  assert.equal(
    buildLiveKitTokenRequestUrl("http://host/v1//", "x"),
    "http://host/v1/session/x/livekit-token"
  );
});

test("parseSessionTuneCommand extracts id (KSP radio dial → bridge SESSION line)", () => {
  assert.equal(parseSessionTuneCommand("SESSION:pilot-abc"), "pilot-abc");
  assert.equal(parseSessionTuneCommand("SESSION:  pilot-xyz  "), "pilot-xyz");
  assert.equal(parseSessionTuneCommand("SESSION:"), null);
  assert.equal(parseSessionTuneCommand("SESSION:   "), null);
  assert.equal(parseSessionTuneCommand("MIC_ON"), null);
});

test("readLiveKitTokenFromJsonBody accepts minimal success payload", () => {
  assert.deepStrictEqual(
    readLiveKitTokenFromJsonBody({ token: "jwt", wsUrl: "wss://x" }),
    { token: "jwt", wsUrl: "wss://x" }
  );
});

test("readLiveKitTokenFromJsonBody throws on missing token", () => {
  assert.throws(
    () => readLiveKitTokenFromJsonBody({ wsUrl: "wss://x" }),
    /missing token/
  );
});

test("readLiveKitTokenFromJsonBody throws on missing wsUrl", () => {
  assert.throws(
    () => readLiveKitTokenFromJsonBody({ token: "t" }),
    /missing wsUrl/
  );
});

test("readLiveKitTokenFromJsonBody rejects empty string token", () => {
  assert.throws(() => readLiveKitTokenFromJsonBody({ token: "", wsUrl: "wss://x" }), /missing token/);
});
