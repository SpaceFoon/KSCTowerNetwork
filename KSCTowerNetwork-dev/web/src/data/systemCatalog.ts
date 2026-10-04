/**
 * Static "system catalog" loader. The catalog is a pre-bundled JSON describing every body in a
 * given planet pack (stock Kerbol, RSS, JNSQ, OPM in v1) — name, parent, radius, atmosphere,
 * orbit semi-major axis. The web app uses it to drive the body picker, the system schematic, and
 * per-body 2D maps without ever asking the game client to publish any extra data.
 *
 * Catalog files live at `web/public/system-catalogs/{worldId}.json`. A 404 (or a `worldId` that
 * starts with `unknown-`) means the player's planet pack isn't in the v1 set; callers MUST treat
 * that as "no system catalog available" and fall back to the existing single-home-body UI. We do
 * NOT silently substitute stock data — that would mis-locate vessels on a real-RSS install.
 */

const BASE_URL = "/system-catalogs";

export type SystemCatalogBody = {
  name: string;
  displayName: string;
  /** `null` for the central star. */
  parent: string | null;
  isStar: boolean;
  radiusM: number;
  hasAtmosphere: boolean;
  atmosphereDepthM?: number;
  rotationPeriodSec?: number;
  gravityParameterM3S2?: number;
  /** Null if not applicable (e.g. central star). */
  sphereOfInfluenceM?: number | null;
  /**
   * Used for log-radius ring placement in the schematic only — NOT for orbit propagation. A value
   * of 0 means "this body sits at the system center" (the star). For moons, it's the SMA around
   * the parent body, not the star.
   */
  semiMajorAxisM: number | null;
};

export type SystemCatalog = {
  schemaVersion: 1;
  worldId: string;
  displayName: string;
  starName: string;
  bodies: SystemCatalogBody[];
};

const cache = new Map<string, Promise<SystemCatalog | null>>();

/**
 * Returns the catalog for `worldId`, or `null` if no catalog is bundled (unknown pack, 404, or a
 * `worldId` we explicitly mark `unknown-...`). Idempotent; the underlying fetch promise is cached
 * so re-renders don't re-fetch.
 */
export function loadSystemCatalog(worldId: string | null | undefined): Promise<SystemCatalog | null> {
  const id = (worldId ?? "").trim();
  if (!id) return Promise.resolve(null);
  if (id.startsWith("unknown-")) return Promise.resolve(null);

  const hit = cache.get(id);
  if (hit) return hit;

  const p = (async (): Promise<SystemCatalog | null> => {
    try {
      const res = await fetch(`${BASE_URL}/${encodeURIComponent(id)}.json`, {
        cache: "force-cache"
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        // Network / 5xx: surface as null rather than blowing up the page; the caller falls back to
        // the existing home-only view, which is strictly no worse than what shipped before.
        // eslint-disable-next-line no-console
        console.warn(`[systemCatalog] ${id} fetch returned ${res.status}`);
        return null;
      }
      const j = (await res.json()) as SystemCatalog;
      if (!j || typeof j !== "object" || j.schemaVersion !== 1) {
        // eslint-disable-next-line no-console
        console.warn(`[systemCatalog] ${id} payload missing/wrong schemaVersion`);
        return null;
      }
      return j;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[systemCatalog] ${id} fetch threw`, err);
      return null;
    }
  })();

  cache.set(id, p);
  return p;
}

/**
 * Lookup a body by name (case-insensitive — telemetry occasionally lower-cases). Returns `null`
 * if the catalog doesn't include it (e.g. an extra moon mod the catalog hasn't been re-baked for).
 */
export function bodyByName(catalog: SystemCatalog | null, name: string | undefined): SystemCatalogBody | null {
  if (!catalog || !name) return null;
  const target = name.toLowerCase();
  for (const b of catalog.bodies) {
    if (b.name.toLowerCase() === target) return b;
  }
  return null;
}

/**
 * Returns the immediate children of `parentName` (e.g. all moons of Jool). Order follows whatever
 * the catalog file has, which is roughly outward-from-parent for stock.
 */
export function childrenOf(catalog: SystemCatalog | null, parentName: string): SystemCatalogBody[] {
  if (!catalog) return [];
  const target = parentName.toLowerCase();
  return catalog.bodies.filter((b) => (b.parent ?? "").toLowerCase() === target);
}

/** Pre-baked basemap URL convention; the loader does not check whether the file exists. */
export function basemapUrlFor(worldId: string, bodyName: string): string {
  return `/maps/${encodeURIComponent(worldId)}/${encodeURIComponent(bodyName)}.svg`;
}
