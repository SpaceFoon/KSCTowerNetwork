/**
 * Unit tests for the room/pilot helpers added by the in-game-radio overhaul.
 *
 * Forces `DEV_IN_MEMORY=1` before the module loads so `useDbPersistence()` is
 * false and we never touch MariaDB. Doesn't bring up Express; route-level
 * coverage is intentionally out of scope here — these tests pin the
 * data-layer invariants the route handler relies on.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "test-secret-test-secret-test-secret";

import test from "node:test";
import assert from "node:assert/strict";

import {
  SessionClosedError,
  addSessionChecklistPhase,
  assignTower,
  banGuestIp,
  banUser,
  blockUserForSession,
  closeSession,
  createSession,
  defaultFrequencyMhz,
  findOpenSessionByFrequency,
  getSessionWithDevSharedBootstrap,
  isIpBanned,
  isServerOwnedRadioFrequency,
  normalizeRequestedFrequencyMhz,
  setSessionPilot
} from "./repository";

test("normalizeRequestedFrequencyMhz accepts canonical band values", () => {
  assert.equal(normalizeRequestedFrequencyMhz("122.000"), "122.000");
  assert.equal(normalizeRequestedFrequencyMhz("118.025"), "118.025");
  assert.equal(normalizeRequestedFrequencyMhz("136.975"), "136.975");
  assert.equal(normalizeRequestedFrequencyMhz("  121.500  "), "121.500");
});

test("normalizeRequestedFrequencyMhz rejects malformed / out-of-band / off-grid", () => {
  // Wrong shape
  assert.equal(normalizeRequestedFrequencyMhz("122.0"), undefined);
  assert.equal(normalizeRequestedFrequencyMhz("122,000"), undefined);
  assert.equal(normalizeRequestedFrequencyMhz("abc.def"), undefined);
  // Out of band
  assert.equal(normalizeRequestedFrequencyMhz("117.000"), undefined);
  assert.equal(normalizeRequestedFrequencyMhz("137.000"), undefined);
  assert.equal(normalizeRequestedFrequencyMhz("136.999"), undefined);
  // Off the 25 kHz grid
  assert.equal(normalizeRequestedFrequencyMhz("122.001"), undefined);
  assert.equal(normalizeRequestedFrequencyMhz("122.123"), undefined);
  // Non-strings
  assert.equal(normalizeRequestedFrequencyMhz(undefined), undefined);
  assert.equal(normalizeRequestedFrequencyMhz(122.0 as unknown), undefined);
});

test("createSession honors caller-supplied frequencyMhz", async () => {
  const room = await createSession("user-pilot-A", { frequencyMhz: "122.000" });
  assert.equal(room.frequencyMhz, "122.000");
});

test("createSession ignores invalid frequencyMhz and falls back to deterministic default", async () => {
  const room = await createSession("user-pilot-B", { frequencyMhz: "999.999" });
  assert.equal(room.frequencyMhz, defaultFrequencyMhz(room.id));
});

test("createSession with no freq still gets the deterministic default", async () => {
  const room = await createSession("user-pilot-C");
  assert.equal(room.frequencyMhz, defaultFrequencyMhz(room.id));
});

test("findOpenSessionByFrequency resolves provisioned server radio channels", async () => {
  const found = await findOpenSessionByFrequency("122.000");
  assert.ok(found, "expected TWR to be provisioned");
  assert.equal(found!.id, "ksc-radio-twr");
  assert.equal(found!.name, "KSC Tower");
  assert.equal(isServerOwnedRadioFrequency("122.000"), true);
});

test("findOpenSessionByFrequency ignores ad-hoc sessions and unknown frequencies", async () => {
  await createSession("user-pilot-D", { frequencyMhz: "118.700" });
  const found = await findOpenSessionByFrequency("118.700");
  assert.equal(found, undefined);
  assert.equal(isServerOwnedRadioFrequency("118.700"), false);
});

test("findOpenSessionByFrequency reopens closed server radio channels", async () => {
  const room = await findOpenSessionByFrequency("121.500");
  assert.ok(room);
  await closeSession(room!.id);
  const reopened = await findOpenSessionByFrequency("121.500");
  assert.equal(reopened!.id, "ksc-radio-emrg");
  assert.equal(reopened!.status, "queued");
});

test("setSessionPilot demotes the prior pilot to spectator", async () => {
  const room = await createSession("user-pilot-orig", { frequencyMhz: "118.750" });
  const updated = await setSessionPilot(room.id, "user-pilot-takeover");
  assert.ok(updated);
  assert.equal(updated!.pilotUserId, "user-pilot-takeover");
  assert.deepEqual(updated!.spectatorUserIds, ["user-pilot-orig"]);
});

test("setSessionPilot is idempotent and does not duplicate the spectator entry", async () => {
  const room = await createSession("user-pilot-idem", { frequencyMhz: "118.775" });
  const a = await setSessionPilot(room.id, "user-pilot-idem");
  assert.equal(a!.pilotUserId, "user-pilot-idem");
  assert.deepEqual(a!.spectatorUserIds, []);
});

test("setSessionPilot throws SessionClosedError on closed rooms", async () => {
  const room = await createSession("user-pilot-closed", { frequencyMhz: "118.800" });
  await closeSession(room.id);
  await assert.rejects(
    () => setSessionPilot(room.id, "user-pilot-other"),
    (err: unknown) => err instanceof SessionClosedError && err.sessionId === room.id
  );
});

test("setSessionPilot returns undefined for an unknown sessionId", async () => {
  const result = await setSessionPilot("does-not-exist", "user-pilot-x");
  assert.equal(result, undefined);
});

test("getSessionWithDevSharedBootstrap is undefined for unknown ids (POST /livekit-token → 404)", async () => {
  const got = await getSessionWithDevSharedBootstrap("ksc-tower-no_such_session_ever", "user-pilot-A");
  assert.equal(got, undefined);
});

test("blocking the assigned controller releases the tower seat", async () => {
  const room = await createSession("user-pilot-block");
  await assignTower(room.id, "user-tower-block");
  const after = await blockUserForSession(room.id, "user-tower-block");
  assert.equal(after?.assignedTowerUserId, undefined);
  assert.ok(after?.blockedUserIds.includes("user-tower-block"));
});

test("a plain ban on an IP-banned guest keeps the IP ban", async () => {
  await banGuestIp("guest_ipcarry", "203.0.113.9", "mod-1");
  await banUser("guest_ipcarry", "mod-2", 3600);
  assert.equal(await isIpBanned("203.0.113.9"), true);
});

test("adding duplicate long checklist phase titles terminates with unique ids", async () => {
  const room = await createSession("user-pilot-phases");
  const title = "x".repeat(80);
  const ids = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = await addSessionChecklistPhase({ sessionId: room.id, basePhases: [], title });
    assert.ok(r);
    ids.add(r!.phaseId);
  }
  assert.equal(ids.size, 4);
});
