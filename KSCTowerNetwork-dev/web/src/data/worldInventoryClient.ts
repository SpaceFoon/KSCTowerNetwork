import { apiFetch } from "../api/client";
import type { KerbinNavAid, KerbinNavAidKind } from "./kerbinNavaids";
import type { KerbinLaunchSite } from "./kerbinLaunchSites";

/**
 * Mirrors the backend's `worldInventorySchema`. Mods/navaids/launchSites are whatever the live KSP
 * install reported, including planet packs (RSS, JNSQ, GPP, …) and Kerbal Konstructs sites.
 */
export type WorldInventoryHomeBody = {
  name: string;
  displayName?: string;
  radiusM: number;
  hasAtmosphere: boolean;
  atmosphereDepthM?: number;
  rotationPeriodSec?: number;
  gravityParameterM3S2?: number;
  fallback?: boolean;
};

export type WorldInventoryModCategory = "planet-pack" | "locations" | "navaids" | "dlc" | "physics" | "other";

export type WorldInventoryMod = {
  id: string;
  name: string;
  category: WorldInventoryModCategory;
  fromAssembly: boolean;
  fromGameData: boolean;
};

export type WorldInventoryNavaid = {
  id: string;
  name: string;
  kind: KerbinNavAidKind;
  frequency: number;
  lat: number;
  lon: number;
  bodyName?: string;
};

export type WorldInventoryLaunchSite = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  source: "psystem" | "kerbal-konstructs";
};

export type WorldInventoryRunway = {
  bodyName: string;
  aerodromeId?: string;
  designator: string;
  thresholdLat: number;
  thresholdLon: number;
  thresholdElevationM?: number;
  headingDeg?: number;
};

export type WorldInventory = {
  receivedAt: number;
  schemaVersion: string;
  scannedAt: number;
  home: WorldInventoryHomeBody;
  mods: WorldInventoryMod[];
  navaids: WorldInventoryNavaid[];
  launchSites: WorldInventoryLaunchSite[];
  /** Optional runway thresholds from the KSP plugin (stock Kerbin KKSC/KAFD when present). */
  runways?: WorldInventoryRunway[];
  /**
   * Stable identifier for the (home body + planet pack) combination, derived server-side.
   * The system-catalog loader maps this to a static bundle for the four supported packs
   * (`kerbin-stock`, `earth-rss`, `kerbin-jnsq`, `kerbin-opm`). May be `unknown-{home}` for
   * other packs — callers should treat that as "no catalog available" and fall back gracefully.
   */
  worldId: string;
};

/**
 * `null` = published nothing yet (backend 404, plugin hasn't entered SC, fresh install). Caller must
 * fall back to bundled defaults in this case so the map still renders something useful.
 */
export async function fetchWorldInventory(sessionId: string): Promise<WorldInventory | null> {
  const id = (sessionId || "").trim();
  if (!id) return null;

  const r = await apiFetch<WorldInventory & { ok: true }>(
    `/v1/world-inventory/${encodeURIComponent(id)}`,
    { method: "GET" }
  );

  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(r.message || `world-inventory fetch failed: ${r.status}`);
  }

  return {
    receivedAt: r.data.receivedAt,
    schemaVersion: r.data.schemaVersion,
    scannedAt: r.data.scannedAt,
    home: r.data.home,
    mods: r.data.mods ?? [],
    navaids: r.data.navaids ?? [],
    launchSites: r.data.launchSites ?? [],
    runways: r.data.runways ?? [],
    // Older backends (pre-deriveWorldId rollout) may not return this field; fall back to a
    // home-name-derived id so the rest of the app still gets *something* sensible.
    worldId: r.data.worldId ?? `unknown-${(r.data.home?.name ?? "").toLowerCase()}`
  };
}

/**
 * Adapts live navaids to the bundled `KerbinNavAid` shape so the rest of the map code can stay
 * agnostic about whether the data came from disk-side MAS configs or our hard-coded fallback.
 * Filters to the home body when `bodyName` was set on the navaid (RSS publishes some MAS aids on
 * Mars/etc; we only show the ones for the body the player is currently flying around).
 */
export function navaidsForHomeBody(inv: WorldInventory): KerbinNavAid[] {
  const home = inv.home.name;
  const out: KerbinNavAid[] = [];
  for (const n of inv.navaids) {
    if (n.bodyName && n.bodyName.length > 0 && n.bodyName.toLowerCase() !== home.toLowerCase()) {
      continue;
    }
    out.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      frequency: n.frequency,
      lat: n.lat,
      lon: n.lon
    });
  }
  return out;
}

/**
 * Navaids for a specific celestial body. Entries without `bodyName` are treated as belonging to
 * `inv.home.name` (MAS cfgs often omit the field on the home body).
 */
export function navaidsForBody(inv: WorldInventory, bodyName: string): KerbinNavAid[] {
  const target = bodyName.trim().toLowerCase();
  const out: KerbinNavAid[] = [];
  for (const n of inv.navaids) {
    const bn = (n.bodyName && n.bodyName.length > 0 ? n.bodyName : inv.home.name).trim().toLowerCase();
    if (bn !== target) continue;
    out.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      frequency: n.frequency,
      lat: n.lat,
      lon: n.lon
    });
  }
  return out;
}

/**
 * Adapts live launch sites into the bundled `KerbinLaunchSite` shape. `psystem` becomes "stock" or
 * "making-history" based on the well-known DLC site names; everything else is "kerbal-konstructs"
 * which the legend already understands.
 */
export function launchSitesForHomeBody(inv: WorldInventory): KerbinLaunchSite[] {
  const dlcNames = new Set(["WOOMERANG", "DESSERT", "BAIKERBANUR", "Woomerang", "Dessert", "Baikerbanur"]);
  return inv.launchSites.map<KerbinLaunchSite>((s) => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    source:
      s.source === "kerbal-konstructs"
        ? "kerbal-konstructs"
        : dlcNames.has(s.id)
          ? "making-history"
          : "stock",
    blurb:
      s.source === "kerbal-konstructs"
        ? "Kerbal Konstructs site (loaded from your installed planet/structure pack)."
        : undefined
  }));
}

/** Launch sites are only scanned on the home body; empty when `bodyName` is not home. */
export function launchSitesForBody(inv: WorldInventory, bodyName: string): KerbinLaunchSite[] {
  if (bodyName.trim().toLowerCase() !== inv.home.name.trim().toLowerCase()) {
    return [];
  }
  return launchSitesForHomeBody(inv);
}
