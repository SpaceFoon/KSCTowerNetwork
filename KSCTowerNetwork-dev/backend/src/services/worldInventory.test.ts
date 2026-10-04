/**
 * World-inventory: plugin POST → zod → deriveWorldId → in-memory store.
 * deriveWorldId regressions break the tower map catalog / static basemap picker — lock them in.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorldId,
  getWorldInventory,
  setWorldInventory,
  worldInventorySchema,
  type WorldInventory
} from "./worldInventory";

function minimalInventory(overrides: Partial<WorldInventory> = {}): WorldInventory {
  return {
    schemaVersion: overrides.schemaVersion ?? "1",
    scannedAt: overrides.scannedAt ?? 1_700_000_000,
    home: {
      name: "Kerbin",
      displayName: "Kerbin",
      radiusM: 600_000,
      hasAtmosphere: true,
      ...overrides.home
    },
    mods: overrides.mods ?? [],
    navaids: overrides.navaids ?? [],
    launchSites: overrides.launchSites ?? []
  };
}

describe("worldInventorySchema", () => {
  it("accepts a minimal stock-Kerbin scan (plugin happy path)", () => {
    const parsed = worldInventorySchema.safeParse(minimalInventory());
    assert.equal(parsed.success, true);
  });

  it("accepts optional home telemetry fields", () => {
    const parsed = worldInventorySchema.safeParse(
      minimalInventory({
        home: {
          name: "Kerbin",
          radiusM: 600_000,
          hasAtmosphere: true,
          rotationPeriodSec: 21_600,
          gravityParameterM3S2: 3.5e12
        }
      })
    );
    assert.equal(parsed.success, true);
  });

  it("rejects non-positive home.radiusM", () => {
    const parsed = worldInventorySchema.safeParse(
      minimalInventory({
        home: { name: "Kerbin", displayName: "Kerbin", radiusM: 0, hasAtmosphere: true }
      })
    );
    assert.equal(parsed.success, false);
  });

  it("accepts optional runways array from plugin", () => {
    const parsed = worldInventorySchema.safeParse(
      minimalInventory({
        runways: [
          {
            bodyName: "Kerbin",
            aerodromeId: "KKSC",
            designator: "09",
            thresholdLat: -0.05,
            thresholdLon: -74.5,
            thresholdElevationM: 69,
            headingDeg: 90
          }
        ]
      })
    );
    assert.equal(parsed.success, true);
  });

  it("rejects navaid latitude out of range", () => {
    const parsed = worldInventorySchema.safeParse(
      minimalInventory({
        navaids: [
          {
            id: "x",
            name: "Bad",
            kind: "VOR",
            frequency: 110,
            lat: 95,
            lon: 0
          }
        ]
      })
    );
    assert.equal(parsed.success, false);
  });
});

describe("deriveWorldId", () => {
  it("returns kerbin-stock for stock Kerbin with no planet packs", () => {
    assert.equal(deriveWorldId(minimalInventory({ mods: [] })), "kerbin-stock");
  });

  it("returns earth-rss when home is Earth (RSS rename)", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          home: { name: "Earth", displayName: "Earth", radiusM: 6_371_000, hasAtmosphere: true },
          mods: []
        })
      ),
      "earth-rss"
    );
  });

  it("returns earth-rss when RealSolarSystem planet pack is present on Kerbin-named home", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          mods: [
            {
              id: "RealSolarSystem",
              name: "RSS",
              category: "planet-pack",
              fromAssembly: true,
              fromGameData: true
            }
          ]
        })
      ),
      "earth-rss"
    );
  });

  it("returns kerbin-jnsq when JNSQ pack is tagged planet-pack", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          mods: [
            {
              id: "JNSQ",
              name: "JNSQ",
              category: "planet-pack",
              fromAssembly: true,
              fromGameData: true
            }
          ]
        })
      ),
      "kerbin-jnsq"
    );
  });

  it("returns kerbin-opm when Outer Planets Mod is tagged planet-pack (id variants)", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          mods: [
            {
              id: "OPM",
              name: "OPM",
              category: "planet-pack",
              fromAssembly: true,
              fromGameData: true
            }
          ]
        })
      ),
      "kerbin-opm"
    );
    assert.equal(
      deriveWorldId(
        minimalInventory({
          mods: [
            {
              id: "OuterPlanetsMod",
              name: "OPM",
              category: "planet-pack",
              fromAssembly: true,
              fromGameData: true
            }
          ]
        })
      ),
      "kerbin-opm"
    );
  });

  it("does not classify as OPM when 'opm' appears only inside a non-planet-pack mod id (RPM false positive)", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          mods: [
            {
              id: "RasterPropMonitor",
              name: "RPM",
              category: "navaids",
              fromAssembly: true,
              fromGameData: true
            }
          ]
        })
      ),
      "kerbin-stock"
    );
  });

  it("returns unknown-{home} for custom home bodies without a known pack", () => {
    assert.equal(
      deriveWorldId(
        minimalInventory({
          home: { name: "Laythe", displayName: "Laythe", radiusM: 500_000, hasAtmosphere: true },
          mods: []
        })
      ),
      "unknown-laythe"
    );
  });
});

describe("setWorldInventory / getWorldInventory", () => {
  it("round-trips and stamps worldId from deriveWorldId", () => {
    const sid = `test-wi-${Date.now()}`;
    const inv = minimalInventory({
      mods: [
        {
          id: "JNSQ",
          name: "JNSQ",
          category: "planet-pack",
          fromAssembly: true,
          fromGameData: true
        }
      ]
    });
    const rec = setWorldInventory(sid, "u1", inv);
    assert.equal(rec.worldId, "kerbin-jnsq");

    const got = getWorldInventory(sid);
    assert.ok(got);
    assert.equal(got!.worldId, "kerbin-jnsq");
    assert.equal(got!.publisherUserId, "u1");
  });
});
