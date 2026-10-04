import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { httpRequestLogSilenced } from "./httpRequestLogSilence";

function req(method: string, url: string, originalUrl?: string): IncomingMessage {
  return { method, url, ...(originalUrl !== undefined ? { originalUrl } : {}) } as IncomingMessage;
}

describe("httpRequestLogSilenced", () => {
  it("silences health and hot polling routes", () => {
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/health")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/lobby/rooms")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/auth/me")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/session/abc")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/session/abc/messages")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/session/xyz/checklist")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/dm/threads")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/hullcam/sid")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/hullcam/sid/cam/snapshot.jpg")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/world-maps/sid")), true);
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/world-inventory/sid")), true);
  });

  it("does not silence arbitrary GETs", () => {
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/admin/users")), false);
  });

  it("silences telemetry POST", () => {
    assert.equal(httpRequestLogSilenced(req("POST", "/v1/telemetry/sid")), true);
  });

  it("silences hullcam frame POST (plugin upload hot path)", () => {
    assert.equal(httpRequestLogSilenced(req("POST", "/v1/hullcam/ksc-radio-twr/123")), true);
    assert.equal(httpRequestLogSilenced(req("POST", "/hullcam/ksc-radio-twr/123", "/v1/hullcam/ksc-radio-twr/123")), true);
  });

  it("strips query string before matching", () => {
    assert.equal(httpRequestLogSilenced(req("GET", "/v1/health?x=1")), true);
  });
});
