import { describe, it, expect } from "vitest";
import { buildKerbinIlsMarkers } from "./kerbinIlsMarkersComputed";

describe("buildKerbinIlsMarkers", () => {
  it("emits KKSC and KAFD markers with stable ids", () => {
    const m = buildKerbinIlsMarkers();
    const ids = new Set(m.map((x) => x.id));
    expect(ids.has("KKSC-09-OM")).toBe(true);
    expect(ids.has("KAFD-09-IM")).toBe(true);
    expect(m.length).toBeGreaterThanOrEqual(6);
  });
});
