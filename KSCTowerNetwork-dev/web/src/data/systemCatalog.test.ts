import { describe, expect, it } from "vitest";
import {
  basemapUrlFor,
  bodyByName,
  childrenOf,
  loadSystemCatalog,
  type SystemCatalog
} from "./systemCatalog";

function catalog(): SystemCatalog {
  return {
    schemaVersion: 1,
    worldId: "kerbin-stock",
    displayName: "Kerbol",
    starName: "Sun",
    bodies: [
      {
        name: "Kerbin",
        displayName: "Kerbin",
        parent: "Sun",
        isStar: false,
        radiusM: 600_000,
        hasAtmosphere: true,
        semiMajorAxisM: 13e9
      },
      {
        name: "Mun",
        displayName: "Mun",
        parent: "Kerbin",
        isStar: false,
        radiusM: 200_000,
        hasAtmosphere: false,
        semiMajorAxisM: 12e6
      }
    ]
  };
}

describe("bodyByName", () => {
  it("matches case-insensitively", () => {
    const b = bodyByName(catalog(), "KERBIN");
    expect(b?.name).toBe("Kerbin");
  });

  it("returns null for missing bodies", () => {
    expect(bodyByName(catalog(), "Laythe")).toBeNull();
    expect(bodyByName(null, "Kerbin")).toBeNull();
  });
});

describe("childrenOf", () => {
  it("returns moons of Kerbin", () => {
    const kids = childrenOf(catalog(), "Kerbin");
    expect(kids.map((k) => k.name)).toContain("Mun");
  });

  it("returns empty for null catalog", () => {
    expect(childrenOf(null, "Kerbin")).toEqual([]);
  });
});

describe("basemapUrlFor", () => {
  it("encodes world and body for static maps path", () => {
    expect(basemapUrlFor("kerbin-stock", "Kerbin")).toBe(
      "/maps/kerbin-stock/Kerbin.svg"
    );
  });
});

describe("loadSystemCatalog", () => {
  it("resolves null for empty and unknown-* ids without fetching", async () => {
    await expect(loadSystemCatalog("")).resolves.toBeNull();
    await expect(loadSystemCatalog("unknown-foo")).resolves.toBeNull();
  });
});
