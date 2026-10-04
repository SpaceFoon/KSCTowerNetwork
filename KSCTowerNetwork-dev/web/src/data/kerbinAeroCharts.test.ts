import { describe, it, expect } from "vitest";
import type { KerbinNavAidKind } from "./kerbinNavaids";
import { approxNavaidRangeKm, KERBIN_NAVAID_CLASS_RANGES } from "./kerbinAeroCharts";

describe("approxNavaidRangeKm", () => {
  it("returns 0 when no chart row matches the kind", () => {
    expect(approxNavaidRangeKm("ZZZ" as KerbinNavAidKind, 5000)).toBe(0);
  });

  it("matches chart anchors at 5000 m and 10000 m for VOR", () => {
    const row = KERBIN_NAVAID_CLASS_RANGES.find((r) => r.kind === "VOR");
    expect(row).toBeDefined();
    expect(approxNavaidRangeKm("VOR", 5000)).toBeCloseTo(row!.rangeKmAt5000m, 5);
    expect(approxNavaidRangeKm("VOR", 10000)).toBeCloseTo(row!.rangeKmAt10000m, 5);
  });

  it("is non-negative and generally increases with altitude (VOR)", () => {
    const a = approxNavaidRangeKm("VOR", 0);
    const b = approxNavaidRangeKm("VOR", 2500);
    const c = approxNavaidRangeKm("VOR", 7500);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThan(b);
  });

  it("clamps negative altitude to sea-level behavior", () => {
    expect(approxNavaidRangeKm("NDB", -100)).toBe(approxNavaidRangeKm("NDB", 0));
  });

  it("ILS stays flat above 5 km per chart (same at 5k and 10k)", () => {
    const row = KERBIN_NAVAID_CLASS_RANGES.find((r) => r.kind === "ILS");
    expect(row).toBeDefined();
    expect(approxNavaidRangeKm("ILS", 5000)).toBeCloseTo(row!.rangeKmAt5000m, 5);
    expect(approxNavaidRangeKm("ILS", 10000)).toBeCloseTo(row!.rangeKmAt10000m, 5);
  });
});
