/**
 * Ordering and rate rules for UDP packets. The socket itself is not opened here; these pin
 * the helpers that decide whether a packet may change state or earn a reply.
 */
process.env.DEV_IN_MEMORY = "1";
process.env.NODE_ENV = "test";
process.env.APP_JWT_SECRET = "udp-worker-test-secret-value-0123456789abcdef";

import test from "node:test";
import assert from "node:assert/strict";

test("a delayed or duplicated sender packet does not replace a newer one", async () => {
  const { __udpTestHooks } = await import("./udpWorker");
  const key = "telemetry.sample|udp-test-session|udp-test-pilot-order";
  const now = Date.now();

  assert.equal(__udpTestHooks.isStaleSenderPacket(key, now), false, "first packet is accepted");
  assert.equal(__udpTestHooks.isStaleSenderPacket(key, now), true, "a duplicate is refused");
  assert.equal(__udpTestHooks.isStaleSenderPacket(key, now - 5), true, "an older packet is refused");
  assert.equal(__udpTestHooks.isStaleSenderPacket(key, now + 5), false, "a newer packet is accepted");
});

test("streams are ordered independently of each other", async () => {
  const { __udpTestHooks } = await import("./udpWorker");
  const now = Date.now();
  assert.equal(__udpTestHooks.isStaleSenderPacket("telemetry.status|udp-test-s2|udp-test-p2", now), false);
  assert.equal(__udpTestHooks.isStaleSenderPacket("telemetry.sample|udp-test-s2|udp-test-p2", now - 10), false);
});

test("a sender clock far from ours is accepted rather than locking the stream", async () => {
  const { __udpTestHooks } = await import("./udpWorker");
  const key = "telemetry.sample|udp-test-session|udp-test-pilot-skew";
  const hourAgo = Date.now() - 3_600_000;
  assert.equal(__udpTestHooks.isStaleSenderPacket(key, hourAgo), false);
  assert.equal(__udpTestHooks.isStaleSenderPacket(key, hourAgo), false);
});

test("ghost queries from one address are capped per second", async () => {
  const { __udpTestHooks } = await import("./udpWorker");
  const address = "198.51.100.77";
  const allowed = [1, 2, 3, 4].map(() => __udpTestHooks.allowGhostQuery(address));
  assert.deepEqual(allowed, [true, true, true, true]);
  assert.equal(__udpTestHooks.allowGhostQuery(address), false);
  assert.equal(__udpTestHooks.allowGhostQuery("198.51.100.78"), true, "other sources are unaffected");
});
