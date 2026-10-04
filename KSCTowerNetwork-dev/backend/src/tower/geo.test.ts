import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { haversineKm } from "./geo";

describe("haversineKm", () => {
  it("returns zero for identical points", () => {
    assert.equal(haversineKm(0.05, -74.5, 0.05, -74.5), 0);
  });

  it("matches a known 1-degree latitude arc on a 600 km body", () => {
    const km = haversineKm(0, 0, 1, 0, 600_000);
    assert.ok(Math.abs(km - 10.471975511965916) < 1e-9);
  });

  it("scales linearly with body radius", () => {
    const kerbin = haversineKm(0, 0, 1, 0, 600_000);
    const mun = haversineKm(0, 0, 1, 0, 200_000);
    assert.ok(Math.abs(mun - kerbin / 3) < 1e-9);
  });

  it("increases with angular separation on the same parallel", () => {
    const small = haversineKm(0.05, -74.5, 0.051, -74.5, 600_000);
    const large = haversineKm(0.05, -74.5, 0.06, -74.5, 600_000);
    assert.ok(Math.abs(small - 0.010471975511965916) < 1e-9);
    assert.ok(large > small);
  });
});
