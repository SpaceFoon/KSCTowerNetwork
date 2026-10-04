import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNonRoutableClientIp, normalizeClientIp } from "./atisIpGeo";

describe("atisIpGeo helpers", () => {
  it("normalizeClientIp strips IPv4-mapped IPv6", () => {
    assert.equal(normalizeClientIp("  ::ffff:192.168.1.10 "), "192.168.1.10");
  });

  it("isNonRoutableClientIp detects loopback and RFC1918", () => {
    assert.equal(isNonRoutableClientIp("127.0.0.1"), true);
    assert.equal(isNonRoutableClientIp("10.0.0.1"), true);
    assert.equal(isNonRoutableClientIp("192.168.0.44"), true);
    assert.equal(isNonRoutableClientIp("172.20.1.1"), true);
    assert.equal(isNonRoutableClientIp("8.8.8.8"), false);
  });
});
