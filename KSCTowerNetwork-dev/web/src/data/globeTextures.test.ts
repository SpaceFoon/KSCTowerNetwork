import { describe, expect, it } from "vitest";
import { globeTextureFor, globeLayersFor, globeMarkerTextureFor } from "./globeTextures";
import { stockSurfaces, opmSurfaces } from "./globeAssetSources";
// @ts-expect-error Node-only asset checks run in Vitest; the SPA excludes Node ambient types.
import { existsSync, readFileSync } from "node:fs";
import type { SystemCatalogBody } from "./systemCatalog";
import type { WorldMapsManifest } from "./worldMapsClient";

const kerbin: SystemCatalogBody = { name: "Kerbin", displayName: "Kerbin", parent: "Kerbol", isStar: false, radiusM: 600000, hasAtmosphere: true, semiMajorAxisM: 1 };
const maps: WorldMapsManifest = { receivedAt: 1, schemaVersion: "v4", scannedAt: 1, body: { name: "kerbin", displayName: "Kerbin", radiusM: 600000 }, features: [], layers: [
  { id: "biome", label: "Biome", contentType: "image/png", viewBoxW: 596, viewBoxH: 298, bytes: 1, etag: "b", url: "/biome" },
  { id: "alt", label: "Terrain", contentType: "image/png", viewBoxW: 596, viewBoxH: 298, bytes: 1, etag: "a", url: "/v1/world-maps/session/layer/alt?v=a" }
] };

describe("globe texture provenance", () => {
  it("prefers the matching live terrain and never uses the biome palette", () => {
    expect(globeTextureFor(kerbin, "kerbin-stock", maps)).toBe(maps.layers[1]!.url);
  });
  it("does not put Kerbin's live texture on another body", () => {
    expect(globeTextureFor({ ...kerbin, name: "Mun" }, "kerbin-stock", maps)).toBe("/globes/mun-stock.webp");
  });
  it("uses the cached stock texture for stock and OPM", () => {
    expect(globeTextureFor(kerbin, "kerbin-stock")).toBe("/globes/kerbin-stock.png");
    expect(globeTextureFor(kerbin, "kerbin-opm")).toBe("/globes/kerbin-stock.png");
  });
  it("does not substitute stock geography for JNSQ or an unknown pack", () => {
    expect(globeTextureFor(kerbin, "kerbin-jnsq")).toBeUndefined();
    expect(globeTextureFor(kerbin, "unknown-mod")).toBeUndefined();
    expect(globeTextureFor(kerbin, "kerbin-jnsq", maps)).toBe(maps.layers[1]!.url);
  });
  it("does not treat an old SVG schematic as a terrain texture", () => {
    expect(globeTextureFor(kerbin, "kerbin-jnsq", { ...maps, layers: maps.layers.map(layer => ({ ...layer, contentType: "image/svg+xml" })) })).toBeUndefined();
  });
  it("has real maps for all stock and OPM planets and moons", () => {
    expect(Object.keys(stockSurfaces)).toHaveLength(16);
    expect(Object.keys(opmSurfaces)).toHaveLength(16);
    for (const name of new Set([...Object.keys(stockSurfaces), ...Object.keys(opmSurfaces)])) {
      expect(globeTextureFor({ ...kerbin, name }, "kerbin-opm")).toMatch(/^\/globes\/.+\.(webp|png)$/);
    }
  });
  it.skipIf(!existsSync(new URL("../../public/globes/kerbin-stock.png", import.meta.url)))("validates every catalog image when optional local textures are installed", () => {
    for (const worldId of ["kerbin-stock", "kerbin-opm"]) {
      const catalog = JSON.parse(readFileSync(new URL(`../../public/system-catalogs/${worldId}.json`, import.meta.url), "utf8"));
      for (const body of catalog.bodies as SystemCatalogBody[]) {
        if (body.isStar) continue;
        for (const url of [globeTextureFor(body, worldId), globeMarkerTextureFor(body, worldId), globeLayersFor(body, worldId).cloud?.url, globeLayersFor(body, worldId).ring?.url].filter(Boolean)) {
          expect(existsSync(new URL(`../../public${url}`, import.meta.url)), `${body.name}: ${url}`).toBe(true);
        }
        expect(globeTextureFor(body, worldId), body.name).toBeDefined();
        expect(globeMarkerTextureFor(body, worldId), body.name).toContain("-marker.webp");
      }
    }
  });
  it("uses OPM's changed Eeloo only for OPM", () => {
    expect(globeTextureFor({ ...kerbin, name: "Eeloo" }, "kerbin-stock")).toBe("/globes/eeloo-stock.webp");
    expect(globeTextureFor({ ...kerbin, name: "Eeloo" }, "kerbin-opm")).toBe("/globes/eeloo-opm.webp");
  });
  it("keeps clouds off airless moons and rings on the correct OPM giants", () => {
    expect(globeLayersFor({ ...kerbin, name: "Mun", hasAtmosphere: false }, "kerbin-opm").cloud).toBeUndefined();
    expect(globeLayersFor({ ...kerbin, name: "Sarnus" }, "kerbin-opm").ring?.url).toContain("sarnus-opm-ring");
    expect(globeLayersFor(kerbin, "kerbin-opm").ring).toBeUndefined();
    expect(globeLayersFor({ ...kerbin, name: "Sarnus" }, "kerbin-stock").ring).toBeUndefined();
    expect(globeLayersFor(kerbin, "kerbin-jnsq")).toEqual({});
  });
});
