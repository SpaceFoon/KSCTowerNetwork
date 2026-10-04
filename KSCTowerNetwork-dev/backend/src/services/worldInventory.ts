import { z } from "zod";

/**
 * Schema for the JSON the KSP plugin (`TowerWorldInventory.cs`) posts once per game session.
 * Anything that fails to parse is rejected with 400 — we never silently keep half-formed inventories
 * because the web map will then mis-locate dots when a planet pack is partially detected.
 */
export const worldInventorySchema = z.object({
  schemaVersion: z.string().min(1).max(8),
  scannedAt: z.number().int().nonnegative(),
  home: z.object({
    name: z.string().min(1).max(64),
    displayName: z.string().max(64).optional(),
    radiusM: z.number().positive().finite(),
    hasAtmosphere: z.boolean(),
    atmosphereDepthM: z.number().nonnegative().finite().optional(),
    rotationPeriodSec: z.number().positive().finite().optional(),
    gravityParameterM3S2: z.number().positive().finite().optional(),
    fallback: z.boolean().optional()
  }),
  mods: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        category: z.enum(["planet-pack", "locations", "navaids", "dlc", "physics", "other"]),
        fromAssembly: z.boolean(),
        fromGameData: z.boolean()
      })
    )
    .max(64),
  navaids: z
    .array(
      z.object({
        id: z.string().min(1).max(32),
        name: z.string().min(1).max(64),
        kind: z.enum(["VOR", "ILS", "NDB"]),
        frequency: z.number().nonnegative().finite(),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        bodyName: z.string().max(64).optional()
      })
    )
    .max(2048),
  launchSites: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        source: z.enum(["psystem", "kerbal-konstructs"])
      })
    )
    .max(2048),
  runways: z
    .array(
      z.object({
        bodyName: z.string().min(1).max(64),
        aerodromeId: z.string().min(1).max(16).optional(),
        designator: z.string().min(1).max(8),
        thresholdLat: z.number().min(-90).max(90),
        thresholdLon: z.number().min(-180).max(180),
        thresholdElevationM: z.number().finite().optional(),
        headingDeg: z.number().finite().optional()
      })
    )
    .max(256)
    .optional()
});

export type WorldInventory = z.infer<typeof worldInventorySchema>;

export type WorldInventoryRecord = WorldInventory & {
  /** Server-side wallclock UNIX seconds; the web pill shows "scanned 14s ago" off this. */
  receivedAt: number;
  /** ID of the user that POSTed (so multiple pilots in one session can't quietly clobber each other). */
  publisherUserId: string;
  /** Derived planet-pack identifier; see `deriveWorldId`. */
  worldId: string;
};

/**
 * Stable identifier for the (home body + planet pack) combination. The web app uses this to pick
 * a static system catalog + pre-baked basemaps from `web/public/system-catalogs/{worldId}.json` and
 * `web/public/maps/{worldId}/{bodyName}.svg`.
 *
 * v1 only distinguishes the four packs we ship catalogs for — stock, RSS, JNSQ, OPM — because that
 * covers the overwhelming majority of installs and matches the static bundle we build. Anything else
 * resolves to `unknown-{home}`, which the web hook treats as "no catalog" → falls back to today's
 * single-body view. Extending support to a new pack is a data-add (catalog + basemaps + one branch
 * here), not a schema change.
 *
 * See `WORLD_AND_TIME_MODEL.md` for the broader cross-cutting design this is the minimum viable
 * version of.
 */
export function deriveWorldId(inv: WorldInventory): string {
  const home = inv.home.name.toLowerCase();
  // Restrict to mods the publisher tagged as `planet-pack`. The other categories (`navaids`,
  // `physics`, ...) MUST NOT influence world detection: e.g. `RasterPropMonitor` (a navaid mod)
  // contains the substring "opm" inside "rasterprOPMonitor", so any naive substring scan over
  // *all* mod ids was misclassifying RPM-equipped stock installs as OPM. We also use exact
  // equality, not includes(), to keep us from re-introducing the same class of false positive
  // when a future planet-pack token happens to share letters with another.
  const planetPackIds = inv.mods
    .filter((m) => m.category === "planet-pack")
    .map((m) => m.id.toLowerCase());
  const hasPack = (...tokens: string[]): boolean => {
    for (const t of tokens) {
      const target = t.toLowerCase();
      if (planetPackIds.some((id) => id === target)) return true;
    }
    return false;
  };

  // RSS is detected by either the explicit mod presence or the home body name swap to Earth.
  // Players sometimes install RSS without the planet-pack flag tripping (e.g. partial scans), so
  // the home-name fallback is what saves them.
  if (home === "earth" || hasPack("realsolarsystem")) return "earth-rss";
  // JNSQ and OPM both keep `home === "kerbin"`, so we MUST check mods to disambiguate from stock.
  if (hasPack("jnsq")) return "kerbin-jnsq";
  // Plugin's `KnownMods` table tags it as just "OPM"; we accept the long form too in case some
  // future scan path uses the folder name verbatim.
  if (hasPack("opm", "outerplanetsmod")) return "kerbin-opm";
  if (home === "kerbin") return "kerbin-stock";
  return `unknown-${home}`;
}

const TTL_SECONDS = 6 * 60 * 60;
const MAX_SESSIONS = 256;

/**
 * In-memory map. Mirrors the rest of `repository.ts` — losing this on restart is fine: the plugin
 * republishes the next time the player loads the Space Center.
 */
const inventories = new Map<string, WorldInventoryRecord>();

function gc(now: number): void {
  if (inventories.size <= MAX_SESSIONS) {
    // Cheap path: only collect when we hit the cap, since planet-pack scans are tiny.
    let expired: string[] | null = null;
    for (const [k, v] of inventories) {
      if (now - v.receivedAt > TTL_SECONDS) {
        (expired ??= []).push(k);
      }
    }
    if (expired) {
      for (const k of expired) inventories.delete(k);
    }
    return;
  }

  const entries = [...inventories.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt);
  const drop = entries.length - MAX_SESSIONS;
  for (let i = 0; i < drop; i++) {
    const e = entries[i];
    if (e) inventories.delete(e[0]);
  }
}

export function setWorldInventory(
  sessionId: string,
  publisherUserId: string,
  inv: WorldInventory
): WorldInventoryRecord {
  const now = Math.floor(Date.now() / 1000);
  const rec: WorldInventoryRecord = {
    ...inv,
    receivedAt: now,
    publisherUserId,
    worldId: deriveWorldId(inv)
  };
  inventories.set(sessionId, rec);
  gc(now);
  return rec;
}

export function getWorldInventory(sessionId: string): WorldInventoryRecord | undefined {
  const rec = inventories.get(sessionId);
  if (!rec) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (now - rec.receivedAt > TTL_SECONDS) {
    inventories.delete(sessionId);
    return undefined;
  }
  return rec;
}
