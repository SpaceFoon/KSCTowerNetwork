import { describe, it, expect } from "vitest";
import type { WorldInventory } from "./worldInventoryClient";
import { launchSitesForHomeBody, navaidsForHomeBody } from "./worldInventoryClient";

function minimalInv(overrides: Partial<WorldInventory> = {}): WorldInventory {
  return {
    receivedAt: 0,
    schemaVersion: "1",
    scannedAt: 0,
    home: { name: "Kerbin", radiusM: 600_000, hasAtmosphere: true },
    mods: [],
    navaids: [],
    launchSites: [],
    worldId: "kerbin-stock",
    ...overrides
  };
}

describe("navaidsForHomeBody", () => {
  it("keeps navaids without bodyName or matching home", () => {
    const inv = minimalInv({
      home: { name: "Kerbin", radiusM: 600_000, hasAtmosphere: true },
      navaids: [
        {
          id: "n1",
          name: "N1",
          kind: "VOR",
          frequency: 111,
          lat: 0,
          lon: 0
        },
        {
          id: "n2",
          name: "Duna",
          kind: "NDB",
          frequency: 222,
          lat: 1,
          lon: 1,
          bodyName: "Duna"
        }
      ]
    });
    const out = navaidsForHomeBody(inv);
    expect(out.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("launchSitesForHomeBody", () => {
  it("tags DLC sites and KK sites by id/source", () => {
    const inv = minimalInv({
      launchSites: [
        { id: "KSC", name: "KSC", lat: 0, lon: 0, source: "psystem" },
        { id: "WOOMERANG", name: "W", lat: 0, lon: 0, source: "psystem" },
        { id: "kk1", name: "KK", lat: 0, lon: 0, source: "kerbal-konstructs" }
      ]
    });
    const sites = launchSitesForHomeBody(inv);
    expect(sites.find((s) => s.id === "KSC")?.source).toBe("stock");
    expect(sites.find((s) => s.id === "WOOMERANG")?.source).toBe("making-history");
    expect(sites.find((s) => s.id === "kk1")?.source).toBe("kerbal-konstructs");
    expect(sites.find((s) => s.id === "kk1")?.blurb).toMatch(/Konstructs/);
  });
});
