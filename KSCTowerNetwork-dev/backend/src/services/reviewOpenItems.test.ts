/**
 * Data-layer checks for the open items from the 2026-10-24 review: the atomic tower claim
 * and the in-memory fallbacks. DEV_IN_MEMORY keeps MariaDB and Redis out of the test.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "review-open-items-secret-value-0123456789";

import test from "node:test";
import assert from "node:assert/strict";

test("claimVacantTower lets exactly one of two concurrent claims take an empty seat", async () => {
  const repo = await import("./repository");
  repo.ensureLocalRoleSeeded("rv-pilot-claim", "pilot");
  const session = await repo.createSession("rv-pilot-claim");

  const results = await Promise.all([
    repo.claimVacantTower(session.id, "rv-tower-a"),
    repo.claimVacantTower(session.id, "rv-tower-b")
  ]);

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, "exactly one claim should win the seat");
  const winner = winners[0];
  assert.ok(winner && winner.ok);
  const winnerTower = winner.session?.assignedTowerUserId;
  assert.ok(winnerTower === "rv-tower-a" || winnerTower === "rv-tower-b");

  const loser = results.find((r) => !r.ok);
  assert.ok(loser && !loser.ok);
  assert.equal(loser.assignedTowerUserId, winnerTower);
});

test("claimVacantTower refuses a seat that is already held and leaves the holder in place", async () => {
  const repo = await import("./repository");
  repo.ensureLocalRoleSeeded("rv-pilot-held", "pilot");
  const session = await repo.createSession("rv-pilot-held");
  const first = await repo.claimVacantTower(session.id, "rv-tower-first");
  assert.equal(first.ok, true);

  const second = await repo.claimVacantTower(session.id, "rv-tower-second");
  assert.equal(second.ok, false);
  assert.equal(second.ok ? undefined : second.assignedTowerUserId, "rv-tower-first");

  const current = await repo.getSession(session.id);
  assert.equal(current?.assignedTowerUserId, "rv-tower-first");
});
