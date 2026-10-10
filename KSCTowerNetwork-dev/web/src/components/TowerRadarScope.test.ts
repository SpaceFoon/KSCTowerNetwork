import { describe, expect, it } from "vitest";
import { radarBlipAgeFade, radarSweepCrossed } from "./TowerRadarScope";

const leadingEdge = -50 * Math.PI / 180;
const turn = 2 * Math.PI;

describe("radar phosphor returns", () => {
  it("detects a beam crossing even when frames skip past the blip", () => {
    const bearing = leadingEdge + turn * 0.1;
    expect(radarSweepCrossed(bearing, 0, 200)).toBe(false);
    expect(radarSweepCrossed(bearing, 200, 400)).toBe(true);
    expect(radarSweepCrossed(bearing, 400, 600)).toBe(false);
  });

  it("detects crossings around the sweep wrap and after a suspended tab", () => {
    const bearing = leadingEdge + turn * 0.02;
    expect(radarSweepCrossed(bearing, 2700, 2900)).toBe(true);
    expect(radarSweepCrossed(bearing, 100, 3000)).toBe(true);
    expect(radarSweepCrossed(bearing, 100, 100)).toBe(false);
  });

  it("decays between passes and becomes bright again on repaint", () => {
    expect(radarBlipAgeFade(1000, 1000)).toBe(1);
    expect(radarBlipAgeFade(1000, 2400)).toBeLessThan(0.4);
    expect(radarBlipAgeFade(1000, 3799)).toBeGreaterThanOrEqual(0.2);
    expect(radarBlipAgeFade(3800, 3800)).toBe(1);
  });
});
