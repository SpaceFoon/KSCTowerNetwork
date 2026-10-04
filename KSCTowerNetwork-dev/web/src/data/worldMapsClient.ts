import { apiFetch } from "../api/client";

/**
 * Mirrors the backend's `worldMapsSchema` GET response — the live, in-game-baked SVG basemap
 * for the active session's home body. Posted by the KSP plugin (`TowerBasemapBaker.cs`) at
 * Space Center entry; served by `/v1/world-maps/:sessionId`.
 *
 * We deliberately do NOT fetch the SVG bytes here — the manifest carries a same-origin `url`
 * for each layer, and the basemap loader in `TowerDesk.tsx` fetches the bytes on demand so the
 * cache key bumps automatically when the etag changes.
 */
export type WorldMapsLayerId = "alt" | "biome" | "slope";

export type WorldMapsLayer = {
  id: WorldMapsLayerId;
  label: string;
  /**
   * Discriminator. v3+ plugins POST PNG textures extracted directly from
   * `body.scaledBody` and `body.BiomeMap`; older builds and any future
   * SVG-based layers (e.g. quantitative slope) keep `image/svg+xml`.
   */
  contentType: "image/svg+xml" | "image/png";
  viewBoxW: number;
  viewBoxH: number;
  /** Min/max sampled height (m) for the altimetry layer. Absent for biome/slope and PNG layers. */
  minH?: number;
  maxH?: number;
  hypsometryKey?: string;
  /** Decoded byte length of the cached layer (informational; UI shows it next to the layer pill). */
  bytes: number;
  /** Weak ETag — already used by the URL's `?v=` cache buster, but exposed for any conditional fetches. */
  etag: string;
  /** Same-origin path; pass directly to `<img src>` / `<image href>` / `fetch()`. */
  url: string;
};

/**
 * Named surface feature extracted from the body's PQSCity / PQSCity2 instances. Stock anomalies
 * (Mun arches, KSC2, monoliths, the Duna face, the pyramids), modded anomalies (Anomaly
 * Surveyor, Sentinel Mission), and any unclassified PQSCity show up as `kind: "anomaly"`.
 * KSC's child building PQSCity instances come back as `kind: "facility"` so the frontend can
 * dedupe them against the launch-site list instead of double-rendering.
 */
export type WorldMapsFeature = {
  name: string;
  lat: number;
  lon: number;
  kind: "anomaly" | "facility" | "unknown";
};

export type WorldMapsManifest = {
  receivedAt: number;
  schemaVersion: string;
  scannedAt: number;
  body: {
    name: string;
    displayName: string;
    radiusM: number;
  };
  layers: WorldMapsLayer[];
  /** Empty array when the body has no PQSCity (gas giants) or the plugin hasn't shipped a v4 manifest yet. */
  features: WorldMapsFeature[];
};

/**
 * `null` = nothing baked yet (404). Caller falls back to the bundled schematic basemap so the
 * map keeps rendering on a vanilla install / before the plugin has reached SC.
 */
export async function fetchWorldMapsManifest(sessionId: string): Promise<WorldMapsManifest | null> {
  const id = (sessionId || "").trim();
  if (!id) return null;

  const r = await apiFetch<WorldMapsManifest & { ok: true }>(
    `/v1/world-maps/${encodeURIComponent(id)}`,
    { method: "GET" }
  );

  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(r.message || `world-maps fetch failed: ${r.status}`);
  }

  return {
    receivedAt: r.data.receivedAt,
    schemaVersion: r.data.schemaVersion,
    scannedAt: r.data.scannedAt,
    body: r.data.body,
    layers: r.data.layers ?? [],
    features: Array.isArray(r.data.features) ? r.data.features : []
  };
}

export function pickLayer(
  manifest: WorldMapsManifest | null,
  preferred: WorldMapsLayerId
): WorldMapsLayer | null {
  if (!manifest) return null;
  return (
    manifest.layers.find((l) => l.id === preferred) ??
    manifest.layers.find((l) => l.id === "alt") ??
    manifest.layers[0] ??
    null
  );
}
