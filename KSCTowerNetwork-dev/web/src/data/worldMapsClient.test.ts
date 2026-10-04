import { describe, expect, it } from "vitest";
import { pickLayer, type WorldMapsLayer, type WorldMapsManifest } from "./worldMapsClient";

function layer(partial: Partial<WorldMapsLayer> & Pick<WorldMapsLayer, "id">): WorldMapsLayer {
  return {
    label: "L",
    contentType: "image/png",
    viewBoxW: 596,
    viewBoxH: 298,
    bytes: 100,
    etag: 'W/"t"',
    url: "/v1/world-maps/s/layer/x",
    ...partial
  };
}

function manifest(layers: WorldMapsLayer[]): WorldMapsManifest {
  return {
    receivedAt: 1,
    schemaVersion: "4",
    scannedAt: 1,
    body: { name: "Kerbin", displayName: "Kerbin", radiusM: 600_000 },
    layers,
    features: []
  };
}

describe("pickLayer", () => {
  it("returns null when manifest is null", () => {
    expect(pickLayer(null, "alt")).toBeNull();
  });

  it("returns the preferred layer when present", () => {
    const m = manifest([layer({ id: "alt" }), layer({ id: "biome", label: "Bio" })]);
    expect(pickLayer(m, "biome")?.id).toBe("biome");
  });

  it("falls back to alt when preferred id is absent", () => {
    const m = manifest([layer({ id: "biome" })]);
    expect(pickLayer(m, "alt")?.id).toBe("biome");
  });

  it("falls back to first layer when neither preferred nor alt exist", () => {
    const m = manifest([layer({ id: "slope" })]);
    expect(pickLayer(m, "biome")?.id).toBe("slope");
  });
});
