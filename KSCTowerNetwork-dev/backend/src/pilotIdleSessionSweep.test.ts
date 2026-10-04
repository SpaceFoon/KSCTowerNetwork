process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "test-secret-test-secret-test-secret";

import test from "node:test";
import assert from "node:assert/strict";

import { isPilotIdleForAutoClose } from "./pilotIdleSessionSweep";
import type { SessionRecord } from "./services/repository";

function baseSession(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: "tower-test",
    pilotUserId: "pilot-1",
    status: "queued",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    blockedUserIds: [],
    spectatorUserIds: [],
    ...over
  } as SessionRecord;
}

test("isPilotIdleForAutoClose is false when idle window disabled", () => {
  const s = baseSession({ lastTelemetryAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(isPilotIdleForAutoClose(s, Date.parse("2020-01-01T01:00:00.000Z"), 0), false);
});

test("isPilotIdleForAutoClose is false without lastTelemetryAt", () => {
  const s = baseSession({});
  assert.equal(isPilotIdleForAutoClose(s, Date.now(), 120), false);
});

test("isPilotIdleForAutoClose excludes server radio and hullcam namespaces", () => {
  const now = Date.parse("2020-01-01T00:03:00.000Z");
  const old = "2020-01-01T00:00:00.000Z";
  assert.equal(isPilotIdleForAutoClose(baseSession({ id: "ksc-radio-twr", lastTelemetryAt: old }), now, 60), false);
  assert.equal(isPilotIdleForAutoClose(baseSession({ id: "KSC-TOWER-abc", lastTelemetryAt: old }), now, 60), false);
  assert.equal(isPilotIdleForAutoClose(baseSession({ id: "dev-shared", lastTelemetryAt: old }), now, 60), false);
});

test("isPilotIdleForAutoClose is false when telemetry is fresh", () => {
  const s = baseSession({ lastTelemetryAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(isPilotIdleForAutoClose(s, Date.parse("2020-01-01T00:01:00.000Z"), 120), false);
});

test("isPilotIdleForAutoClose is true when telemetry age meets threshold", () => {
  const s = baseSession({ lastTelemetryAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(isPilotIdleForAutoClose(s, Date.parse("2020-01-01T00:02:01.000Z"), 120), true);
});

test("isPilotIdleForAutoClose ignores closed sessions", () => {
  const s = baseSession({
    status: "closed",
    lastTelemetryAt: "2020-01-01T00:00:00.000Z"
  });
  assert.equal(isPilotIdleForAutoClose(s, Date.parse("2020-01-01T01:00:00.000Z"), 60), false);
});
