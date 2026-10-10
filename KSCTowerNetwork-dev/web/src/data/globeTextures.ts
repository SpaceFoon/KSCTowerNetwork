import type { SystemCatalogBody } from "./systemCatalog";
import type { WorldMapsManifest } from "./worldMapsClient";
import { stockSurfaces, opmSurfaces } from "./globeAssetSources";

type Surface = { url: string; source: string; width: number; height: number };
export type GlobeLayers = {
  surface?: Surface;
  cloud?: { url: string; tint: string; opacity: number };
  ring?: { url: string; inner: number; outer: number };
};
const cloudLayers: Record<string, NonNullable<GlobeLayers["cloud"]>> = {
  kerbin: { url: "/globes/kerbin-avp-clouds.webp", tint: "#ffffff", opacity: .78 },
  laythe: { url: "/globes/laythe-avp-clouds.webp", tint: "#c4dcf0", opacity: .65 },
  eve: { url: "/globes/eve-avp-clouds.webp", tint: "#8c379b", opacity: 1 },
  duna: { url: "/globes/duna-avp-clouds.webp", tint: "#ffffff", opacity: .45 },
  jool: { url: "/globes/jool-avp-clouds.webp", tint: "#a0c95b", opacity: .28 },
  sarnus: { url: "/globes/jool-avp-clouds.webp", tint: "#e18c64", opacity: .35 },
  tekto: { url: "/globes/eve-avp-clouds.webp", tint: "#8cffc8", opacity: 1 },
  urlum: { url: "/globes/cirrus-avp-clouds.webp", tint: "#64faff", opacity: .32 },
  neidon: { url: "/globes/cirrus-avp-clouds.webp", tint: "#ff64ff", opacity: .25 },
  thatmo: { url: "/globes/duna-avp-clouds.webp", tint: "#ffffff", opacity: .2 },
};

export function globeLayersFor(body: SystemCatalogBody, worldId: string): GlobeLayers {
  const name = body.name.toLowerCase();
  const stock = worldId === "kerbin-stock", opm = worldId === "kerbin-opm";
  if ((!stock && !opm) || body.isStar) return {};
  const surface = (opm ? (opmSurfaces as Record<string, Surface>)[name] : undefined)
    ?? (stockSurfaces as Record<string, Surface>)[name];
  return {
    surface,
    cloud: surface && body.hasAtmosphere ? cloudLayers[name] : undefined,
    ring: opm && ["sarnus", "urlum"].includes(name)
      ? { url: `/globes/${name}-opm-ring.webp`, inner: name === "sarnus" ? 1.25 : 1.4, outer: 2.4 }
      : undefined,
  };
}

export function globeTextureFor(body: SystemCatalogBody, worldId: string, maps?: WorldMapsManifest | null): string | undefined {
  if (maps?.body.name.toLowerCase() === body.name.toLowerCase()) {
    const terrain = maps.layers.find(layer => layer.id === "alt" && layer.contentType === "image/png");
    if (terrain) return terrain.url;
  }
  return globeLayersFor(body, worldId).surface?.url;
}

export function globeMarkerTextureFor(body: SystemCatalogBody, worldId: string): string | undefined {
  return globeLayersFor(body, worldId).surface?.url.replace(/\.(webp|png)$/, "-marker.webp");
}
