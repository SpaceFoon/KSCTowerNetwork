import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeBridgeBindHosts,
  buildLiveKitTokenRequestUrl,
  parseSessionTuneCommand,
  readLiveKitTokenFromJsonBody
} from "../src/bridgeProtocol.js";

test("bridge bind guard accepts loopback hosts", () => {
  assert.deepStrictEqual(
    assertSafeBridgeBindHosts({ pcmHost: "127.0.0.2", ctlHost: "::1" }, false),
    []
  );
  assert.deepStrictEqual(
    assertSafeBridgeBindHosts({ pcmHost: "localhost", ctlHost: "::ffff:127.0.0.1" }, false),
    []
  );
});

test("bridge bind guard refuses non-loopback hosts by default", () => {
  assert.throws(
    () => assertSafeBridgeBindHosts({ pcmHost: "0.0.0.0", ctlHost: "127.0.0.1" }, false),
    /ALLOW_NON_LOOPBACK_BIND=1/
  );
});

test("bridge bind guard returns exposed hosts when the override is enabled", () => {
  assert.deepStrictEqual(
    assertSafeBridgeBindHosts({ pcmHost: "0.0.0.0", ctlHost: "192.168.1.4" }, true),
    ["PCM_HOST=0.0.0.0", "CTL_HOST=192.168.1.4"]
  );
});

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
