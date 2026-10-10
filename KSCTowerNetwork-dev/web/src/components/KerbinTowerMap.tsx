import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { flushSync } from "react-dom";
import { KERBIN_NAVAIDS, type KerbinNavAid, type KerbinNavAidKind } from "../data/kerbinNavaids";
import {
  approxNavaidRangeKm,
  KERBIN_AERODROMES,
  KERBIN_AERODROME_FREQUENCIES,
  KKSC_ILS_GEOMETRY,
  type KerbinAerodrome,
  type KerbinIlsMarker
} from "../data/kerbinAeroCharts";
import { buildKerbinIlsMarkers } from "../data/kerbinIlsMarkersComputed";
import { KERBIN_LAUNCH_SITES, type KerbinLaunchSite } from "../data/kerbinLaunchSites";
import { bodyByName, loadSystemCatalog, type SystemCatalog } from "../data/systemCatalog";
import {
  launchSitesForHomeBody,
  navaidsForHomeBody,
  type WorldInventory
} from "../data/worldInventoryClient";
import {
  fetchWorldMapsManifest,
  type WorldMapsLayer,
  type WorldMapsLayerId,
  type WorldMapsManifest
} from "../data/worldMapsClient";
import {
  KERBIN_MAP_PRESERVE_ASPECT,
  KERBIN_MAP_VB_H,
  KERBIN_MAP_VB_W,
  patchKerbinTerrainSvgRoot
} from "../maps/kerbinTerrainSvgPatch";
import { apiFetchResponse } from "../api/client";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { computeKkscTowerGuidance } from "../tower/approachGuidance";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";
import { commsStatus, commsStatusLabel } from "./mapComms";
import { MapBodyDropdown } from "./MapBodyDropdown";
import { MapToolbarPopover } from "./MapToolbarPopover";

/**
 * Self-contained Kerbin/home-body map. Originally lived inline in `TowerDesk`; lifted here so the
 * Tower Wall page (and future "wall mode" of the Tower page) can reuse the EXACT same component
 * without duplicating ~1500 lines of zoom/pan/basemap-fetch/marker-modal plumbing.
 *
 * Each instance owns its own zoom, pan, overlay toggles, basemap fetch, click-pick, and marker
 * modal — so two map slots on the same wall can hold different views simultaneously. Persistence
 * to `localStorage` is opt-in via `persistKey`; the primary Tower instance passes a stable key,
 * the wall slots pass `undefined` so each slot starts at sensible defaults instead of trampling
 * the primary's saved layer / body / height preferences.
 */

export type CraftMapIcon = "plane" | "rover" | "rocket";

export type Telemetry = {
  craftName?: string;
  pilotName?: string;
  craftType?: string;
  craftMapIcon?: CraftMapIcon;
  universalTime?: number;
  bodyName?: string;
  situation?: string;
  biome?: string;
  lat?: number;
  lon?: number;
  radarAlt?: number;
  aslAlt?: number;
  surfaceSpeed?: number;
  verticalSpeed?: number;
  heading?: number;
  aoa?: number;
  throttle?: number;
  gearDown?: boolean;
  brakes?: boolean;
  lights?: boolean;
  rcs?: boolean;
  sas?: boolean;
  apoapsis?: number;
  periapsis?: number;
  gLoad?: number;
  wetMass?: number;
  dryMass?: number;
  crewCurrent?: number;
  crewCapacity?: number;
  crewNames?: string[];
  radiation?: number;
  radiationAvailable?: boolean;
  /**
   * Kerbalism Phase 4 (KERBALISM_TELEMETRY_PLAN.md, brought forward onto the
   * Tower Desk): life-support resource burn-down + per-crew dose + storm
   * window. `kerbalismAvailable` is the capability flag — present even when
   * the namespaced block is omitted so the UI can render a "Kerbalism not
   * installed" fallback without a separate probe.
   */
  kerbalismAvailable?: boolean;
  kerbalism?: {
    lifeSupport?: Record<
      string,
      {
        amount: number;
        max: number;
        ratePerSec: number;
        secondsRemaining: number | null;
        daysRemaining: number | null;
      }
    >;
    crew?: Array<{ name: string; doseRad: number }>;
    storm?: { incoming: boolean; durationSec?: number };
  };
  /**
   * Per-kerbal stock stats (trait, level, courage, stupidity, veteran/badass).
   * Empty when the plugin build predates Phase 4; consumer falls back to
   * `crewNames` for those.
   */
  crewStats?: Array<{
    name: string;
    trait: string;
    type: string;
    experienceLevel: number;
    experience: number;
    courage: number;
    stupidity: number;
    isVeteran: boolean;
    isBadass: boolean;
  }>;
  commNetAvailable?: boolean;
  commLink?: boolean;
  commLinkHome?: boolean;
  commSignal?: number;
  targetRunway?: string;
  sampleUnixMs?: number;
  smoothedPositionValid?: boolean;
  smoothedLat?: number;
  smoothedLon?: number;
  smoothedAslAlt?: number;
  srfVelNorth?: number;
  srfVelEast?: number;
  srfVelUp?: number;
  distKSC?: number;
  bearingKSC?: number;
  alignErr?: number;
  activeRunway?: string;
  kscAerodrome?: string;
  onApproach?: boolean;
  landing?: boolean;
  flightPhase?: string;
  touchdownEtaSec?: number;
  fuelLow?: boolean;
  radioFreqMhz?: number;
  radioPtt?: boolean;
  /**
   * FAR (Ferram Aerospace Research) — aggregate flap step + any spoiler deployed.
   * Omitted when FAR is not installed (`TowerTelemetryPublisher` only emits when present).
   */
  far?: {
    available: boolean;
    flap: number;
    spoiler: boolean;
  };
  /** Session ATC callsign when merged onto telemetry by the backend. */
  callsign?: string;
};

/** Primary map / strip label: callsign, else craft name, else pilot display name. */
export function aircraftPrimaryLabel(t: Telemetry | null | undefined): string {
  if (!t) return "Unknown";
  const cs = t.callsign?.trim();
  if (cs) return cs.slice(0, 64);
  const craft = t.craftName?.trim();
  if (craft) return craft.slice(0, 64);
  const pilot = t.pilotName?.trim();
  if (pilot) return pilot.slice(0, 64);
  return "Unknown";
}

/** One aircraft plotted on the tower map (focused session and/or `/v1/tower/active-aircraft`). */
export type TowerAircraftTrack = {
  id: string;
  /** Primary line in the label block (callsign or craft name). */
  label: string;
  telemetry: Telemetry;
  isSelf?: boolean;
};

/**
 * One operator-placed map pin shared with everyone in the room. Mirrors the backend's
 * `SharedWaypoint` (services/repository.ts) — kept minimal here because the map only renders
 * geometry + label, never editing identity / authorship beyond the delete control.
 */
export type SharedMapWaypoint = {
  id: string;
  bodyName: string;
  lat: number;
  lon: number;
  label?: string;
  color?: string;
  createdAt: string;
  createdBy: string;
};

/**
 * Slim shape of the `/v1/session/:id` payload used inside this component. The full session
 * record is much larger; we only depend on `sharedWaypoints` for the room-shared pins. Keeping
 * this local (instead of importing the backend's `SessionRecord`) prevents a thick coupling to
 * server types from leaking through the map module.
 */
type SessionDetailLite = {
  ok?: boolean;
  session?: {
    sharedWaypoints?: SharedMapWaypoint[];
  };
};

// ─── shared formatters (used by TowerDesk telemetry table too — exported) ──────────────────

export function formatNum(n: number | undefined, digits = 1): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

export function formatBool(b: boolean | undefined): string {
  if (b === undefined) return "—";
  return b ? "on" : "off";
}

/**
 * FAR `flapSetting` aggregate across the vessel (0 = retracted … 3 = full), matching
 * the plugin’s `TryGetFarSurfaceState` / `FARControllableSurface.flapSetting`.
 */
export function formatFarFlapSetting(flap: number | undefined): string {
  if (flap == null || !Number.isFinite(flap)) return "—";
  const n = Math.round(flap);
  switch (n) {
    case 0:
      return "up";
    case 1:
      return "1";
    case 2:
      return "2";
    case 3:
      return "full";
    default:
      return String(n);
  }
}

export function formatMassTons(m: number | undefined): string {
  if (m === undefined || Number.isNaN(m)) return "—";
  if (m < 1) return `${(m * 1000).toFixed(0)} kg`;
  if (m < 100) return `${m.toFixed(2)} t`;
  return `${m.toFixed(1)} t`;
}

export function formatRadiation(r: number | undefined): string {
  if (r === undefined || Number.isNaN(r)) return "—";
  const abs = Math.abs(r);
  if (abs < 1e-9) return "0 rad/s";
  if (abs < 1e-6) return `${(r * 1e9).toFixed(2)} nrad/s`;
  if (abs < 1e-3) return `${(r * 1e6).toFixed(2)} µrad/s`;
  if (abs < 1) return `${(r * 1e3).toFixed(3)} mrad/s`;
  return `${r.toFixed(3)} rad/s`;
}

/**
 * Human-readable burn-down used by the Kerbalism life-support row. Prefers
 * "Nd Hh" for anything ≥ 1 day, falling back to "Hh Mm" then "Mm Ss" so the
 * controller can read "FOOD: 12d 4h" or "O2: 14m 03s" at a glance.
 *
 * `daysRemaining` is in **home-body days** (Kerbin = 6 h, RSS Earth = 24 h),
 * so the second arg lets us re-derive seconds when the plugin sent both —
 * keeping the display unit consistent with what KSP shows the player in-game.
 */
export function formatDuration(secondsRemaining: number | null | undefined): string {
  if (secondsRemaining == null || !Number.isFinite(secondsRemaining)) return "—";
  if (secondsRemaining < 0) return "—";
  const sec = Math.floor(secondsRemaining);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes >= 1) return `${minutes}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Render Kerbalism's "days remaining" reading. When the plugin sent
 * `daysRemaining` directly we honor it (so RSS / JNSQ players see their own
 * day length); otherwise we fall back to deriving from `secondsRemaining`
 * using the Kerbin default (21600 s / day).
 */
export function formatKerbinDays(
  daysRemaining: number | null | undefined,
  secondsRemainingFallback?: number | null | undefined
): string {
  if (daysRemaining != null && Number.isFinite(daysRemaining)) {
    if (daysRemaining < 0) return "—";
    if (daysRemaining < 1) {
      const hrs = daysRemaining * 24;
      if (hrs < 1) return `${(hrs * 60).toFixed(0)} min`;
      return `${hrs.toFixed(1)} h`;
    }
    if (daysRemaining < 10) return `${daysRemaining.toFixed(1)} d`;
    return `${Math.floor(daysRemaining)} d`;
  }
  if (secondsRemainingFallback != null && Number.isFinite(secondsRemainingFallback)) {
    return formatDuration(secondsRemainingFallback);
  }
  return "—";
}

export function formatCrew(t: Telemetry): string {
  if (t.crewCurrent == null && t.crewCapacity == null) return "—";
  const cur = t.crewCurrent ?? 0;
  const cap = t.crewCapacity ?? 0;
  return `${cur} / ${cap}`;
}

// ─── geometry / projection ─────────────────────────────────────────────────────────────────

export const KERBIN_RADIUS_M = 600000;
const KST_CENTER_NAVAID = KERBIN_NAVAIDS.find((n) => n.id === "KST");
export const KSC_LAT = KST_CENTER_NAVAID?.lat ?? -0.06301651539;
export const KSC_LON = KST_CENTER_NAVAID?.lon ?? -74.63320905499;
export const NEAR_KSC_M = 100000;

const KERBIN_GEO_TRIM_FRAC = { x: 0, y: 0 } as const;
const KERBIN_GEO_SHIFT_X_VB = 0;

const KERBIN_MERIDIANS: readonly number[] = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const KERBIN_PARALLELS: readonly number[] = [-60, -30, 0, 30, 60];

function geoPlotBounds(): { insetX: number; insetY: number; plotW: number; plotH: number } {
  const insetX = KERBIN_GEO_TRIM_FRAC.x * KERBIN_MAP_VB_W;
  const insetY = KERBIN_GEO_TRIM_FRAC.y * KERBIN_MAP_VB_H;
  const plotW = Math.max(1, KERBIN_MAP_VB_W - 2 * insetX);
  const plotH = Math.max(1, KERBIN_MAP_VB_H - 2 * insetY);
  return { insetX, insetY, plotW, plotH };
}

function normalizeLon(lon: number): number {
  let out = lon;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

function latLonToMapVB(lat: number, lon: number): { x: number; y: number } {
  const { insetX, insetY, plotW, plotH } = geoPlotBounds();
  const u = (normalizeLon(lon) + 180) / 360;
  const v = (90 - lat) / 180;
  return { x: insetX + u * plotW + KERBIN_GEO_SHIFT_X_VB, y: insetY + v * plotH };
}

function lonToMapX(lon: number): number {
  const { insetX, plotW } = geoPlotBounds();
  const u = (normalizeLon(lon) + 180) / 360;
  return insetX + u * plotW + KERBIN_GEO_SHIFT_X_VB;
}

function latToMapY(lat: number): number {
  const { insetY, plotH } = geoPlotBounds();
  const v = (90 - lat) / 180;
  return insetY + v * plotH;
}

function mapVBToLatLon(x: number, y: number): { lat: number; lon: number } {
  const { insetX, insetY, plotW, plotH } = geoPlotBounds();
  const xr = x - KERBIN_GEO_SHIFT_X_VB;
  const xc = Math.min(insetX + plotW, Math.max(insetX, xr));
  const yc = Math.min(insetY + plotH, Math.max(insetY, y));
  const u = (xc - insetX) / plotW;
  const v = (yc - insetY) / plotH;
  const lon = normalizeLon(u * 360 - 180);
  const lat = Math.min(90, Math.max(-90, 90 - v * 180));
  return { lat, lon };
}

function clientToMapLatLon(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): { lat: number; lon: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  let inv: DOMMatrix;
  try {
    inv = ctm.inverse();
  } catch {
    return null;
  }
  const p = new DOMPoint(clientX, clientY).matrixTransform(inv);
  return mapVBToLatLon(p.x, p.y);
}

function mapVBPointToClient(
  svg: SVGSVGElement,
  x: number,
  y: number
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const p = new DOMPoint(x, y).matrixTransform(ctm);
  return { x: p.x, y: p.y };
}

/**
 * Project a (lat, lon) along a true-north bearing for `distKm` km on a sphere
 * of radius `bodyRadiusKm`. Equirectangular small-angle approximation, which
 * is plenty for runway-scale geometry (~10 km against a 600 km body — error
 * stays below half a meter). Used by the approach-layer to draw extended
 * centerlines and missed-approach turn points without baking pre-computed
 * coordinates into `kerbinAeroCharts.ts`.
 */
function projectLatLonBearing(
  lat: number,
  lon: number,
  bearingDeg: number,
  distKm: number,
  bodyRadiusKm: number
): { lat: number; lon: number } {
  const angDeg = (distKm / Math.max(1, bodyRadiusKm)) * (180 / Math.PI);
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const dLat = angDeg * Math.cos(bearingRad);
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dLon = (angDeg * Math.sin(bearingRad)) / cosLat;
  return { lat: lat + dLat, lon: lon + dLon };
}

export function kerbinDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusM: number = KERBIN_RADIUS_M
): number {
  const d2r = Math.PI / 180;
  const p1 = lat1 * d2r;
  const p2 = lat2 * d2r;
  const dp = (lat2 - lat1) * d2r;
  const dl = (normalizeLon(lon2) - normalizeLon(lon1)) * d2r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── basemap manifest ──────────────────────────────────────────────────────────────────────

/** Always ends with `/` so `maps/…` joins resolve from the SPA root (never `/tower/maps/…` 404s). */
const RAW_VITE_BASE = (import.meta.env.BASE_URL ?? "/").trim();
const MAP_ASSET_BASE =
  RAW_VITE_BASE.length === 0 ? "/" : RAW_VITE_BASE.endsWith("/") ? RAW_VITE_BASE : `${RAW_VITE_BASE}/`;
const BASEMAP_JSON = `${MAP_ASSET_BASE}maps/basemap.json`;

/**
 * Bundled files under `/maps/` are public. `/v1/world-maps/.../layer/*` requires the same
 * credentials as `apiFetch` — plain `fetch` / `<img src>` omit `Authorization`, so bearer-only
 * sessions never painted the live bake.
 */
async function fetchBasemapHttp(url: string, signal: AbortSignal): Promise<Response> {
  if (url.startsWith("/v1/")) {
    const r = await apiFetchResponse(url, { method: "GET", signal });
    if (!r.ok) throw new Error(r.message || `Basemap HTTP ${r.status}`);
    return r.response;
  }
  const r = await fetch(url, { signal, credentials: "include" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r;
}

type KerbinBasemapKind = "svg" | "raster";
type KerbinHypsometryKeyMode = "jebbesen" | "generic";

type KerbinBasemapLayerOverride = {
  uri: string;
  assetVersion?: number;
  attribution?: string;
  chartBlurb?: string;
  hypsometryKey?: KerbinHypsometryKeyMode;
};

type KerbinBasemapManifest = {
  projection: "equirectangular";
  viewBoxWidth: number;
  viewBoxHeight: number;
  kind: KerbinBasemapKind;
  uri: string;
  assetVersion?: number;
  attribution: string;
  chartBlurb?: string;
  hypsometryKey?: KerbinHypsometryKeyMode;
  layers?: Partial<Record<WorldMapsLayerId, KerbinBasemapLayerOverride>>;
  byBody?: Record<string, KerbinBasemapManifest>;
};

const DEFAULT_CHART_BLURB =
  "Equirectangular basemap. Rim labels track the viewport on zoom/pan.";

function parseKerbinBasemapLayerOverride(raw: unknown): KerbinBasemapLayerOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.uri !== "string" || o.uri.length === 0) return null;
  const hypsometryKey = o.hypsometryKey;
  return {
    uri: o.uri,
    assetVersion: typeof o.assetVersion === "number" ? o.assetVersion : undefined,
    attribution: typeof o.attribution === "string" ? o.attribution : undefined,
    chartBlurb: typeof o.chartBlurb === "string" ? o.chartBlurb : undefined,
    hypsometryKey:
      hypsometryKey === "jebbesen" || hypsometryKey === "generic" ? hypsometryKey : undefined
  };
}

function parseKerbinBasemapManifest(raw: unknown): KerbinBasemapManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.projection !== "equirectangular") return null;
  if (o.kind !== "svg" && o.kind !== "raster") return null;
  if (typeof o.uri !== "string" || o.uri.length === 0) return null;
  if (typeof o.viewBoxWidth !== "number" || typeof o.viewBoxHeight !== "number") return null;
  if (typeof o.attribution !== "string") return null;
  const hypsometryKey = o.hypsometryKey;
  let byBody: Record<string, KerbinBasemapManifest> | undefined;
  if (o.byBody && typeof o.byBody === "object") {
    const entries: [string, KerbinBasemapManifest][] = [];
    for (const [k, v] of Object.entries(o.byBody as Record<string, unknown>)) {
      const inner = parseKerbinBasemapManifest(v);
      if (inner) entries.push([k, inner]);
    }
    if (entries.length > 0) byBody = Object.fromEntries(entries);
  }
  let layers: Partial<Record<WorldMapsLayerId, KerbinBasemapLayerOverride>> | undefined;
  if (o.layers && typeof o.layers === "object") {
    const out: Partial<Record<WorldMapsLayerId, KerbinBasemapLayerOverride>> = {};
    for (const [k, v] of Object.entries(o.layers as Record<string, unknown>)) {
      if (k !== "alt" && k !== "biome" && k !== "slope") continue;
      const inner = parseKerbinBasemapLayerOverride(v);
      if (inner) out[k as WorldMapsLayerId] = inner;
    }
    if (Object.keys(out).length > 0) layers = out;
  }
  return {
    projection: "equirectangular",
    viewBoxWidth: o.viewBoxWidth,
    viewBoxHeight: o.viewBoxHeight,
    kind: o.kind,
    uri: o.uri,
    assetVersion: typeof o.assetVersion === "number" ? o.assetVersion : undefined,
    attribution: o.attribution,
    chartBlurb: typeof o.chartBlurb === "string" ? o.chartBlurb : undefined,
    hypsometryKey:
      hypsometryKey === "jebbesen" || hypsometryKey === "generic" ? hypsometryKey : undefined,
    layers,
    byBody
  };
}

function applyBasemapLayer(
  manifest: KerbinBasemapManifest,
  layerId: WorldMapsLayerId
): KerbinBasemapManifest {
  const ov = manifest.layers?.[layerId];
  if (!ov) return manifest;
  return {
    ...manifest,
    uri: ov.uri,
    assetVersion: ov.assetVersion ?? manifest.assetVersion,
    attribution: ov.attribution ?? manifest.attribution,
    chartBlurb: ov.chartBlurb ?? manifest.chartBlurb,
    hypsometryKey: ov.hypsometryKey ?? manifest.hypsometryKey
  };
}

function resolveBasemapForBody(
  manifest: KerbinBasemapManifest,
  homeBodyName: string
): KerbinBasemapManifest {
  const entries = manifest.byBody;
  if (!entries) return manifest;
  const want = homeBodyName.trim().toLowerCase();
  if (!want) return manifest;
  for (const [k, v] of Object.entries(entries)) {
    if (k.trim().toLowerCase() === want) return v;
  }
  return manifest;
}

// ─── persistence (per-instance opt-in) ─────────────────────────────────────────────────────

type BasemapLayerPref = WorldMapsLayerId | "schematic";
// "schematic" = Kerbin vector basemap from `basemap.json` (default `kerbin-base-schematic.svg`).
// `patchKerbinTerrainSvgRoot` remaps legacy cropped-plate root viewBoxes into the overlay 596×298 frame.
const DEFAULT_BASEMAP_LAYER_PREF: BasemapLayerPref = "schematic";
type MapBodyPref = "auto" | string;
const DEFAULT_MAP_BODY_PREF: MapBodyPref = "auto";

function basemapLayerKey(persistKey: string): string {
  return `ksct.kerbinmap.${persistKey}.basemapLayer`;
}
function mapBodyKey(persistKey: string): string {
  return `ksct.kerbinmap.${persistKey}.mapBody`;
}

function towerGuidanceKey(persistKey: string): string {
  return `ksct.kerbinmap.${persistKey}.towerGuidance`;
}

/** Default-on: distance rings, approach cones, and multi-aircraft labels for tower control. */
function readTowerGuidancePref(persistKey: string | undefined): boolean {
  if (!persistKey || typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(towerGuidanceKey(persistKey)) !== "0";
  } catch {
    return true;
  }
}

function writeTowerGuidancePref(persistKey: string | undefined, v: boolean): void {
  if (!persistKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(towerGuidanceKey(persistKey), v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function readBasemapLayerPref(persistKey: string | undefined): BasemapLayerPref {
  if (!persistKey || typeof window === "undefined") return DEFAULT_BASEMAP_LAYER_PREF;
  try {
    const v = window.localStorage.getItem(basemapLayerKey(persistKey));
    if (v === "alt" || v === "biome" || v === "slope" || v === "schematic") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_BASEMAP_LAYER_PREF;
}
function writeBasemapLayerPref(persistKey: string | undefined, v: BasemapLayerPref): void {
  if (!persistKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(basemapLayerKey(persistKey), v);
  } catch {
    /* ignore */
  }
}
function readMapBodyPref(persistKey: string | undefined): MapBodyPref {
  if (!persistKey || typeof window === "undefined") return DEFAULT_MAP_BODY_PREF;
  try {
    const v = window.localStorage.getItem(mapBodyKey(persistKey));
    if (typeof v === "string" && v.length > 0 && v.length <= 64) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_MAP_BODY_PREF;
}
function writeMapBodyPref(persistKey: string | undefined, v: MapBodyPref): void {
  if (!persistKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(mapBodyKey(persistKey), v);
  } catch {
    /* ignore */
  }
}

// ─── zoom / pan ────────────────────────────────────────────────────────────────────────────

const MAP_ZOOM_MIN = 0.35;
// 1500x lets you zoom from "whole planet" all the way down to runway-scale (~2.5 km
// wide on-screen at max zoom for KSC), so KKSC fills the frame for final checks. The
// previous 64x cap stopped a couple of zoom levels short of useful runway
// detail. We don't go higher because at 2000+ the equirectangular projection
// pixelates the bundled basemap raster faster than the SVG vector layers
// (graticule + approaches + markers) can compensate.
const MAP_ZOOM_MAX = 1500;
const MAP_CLICK_PAN_THRESHOLD_PX = 8;
const MAP_MARKER_HIT_PX = 20;

function panLinearZoomAnchor(
  p0: { x: number; y: number },
  z0: number,
  z1: number,
  ax: number,
  ay: number
): { x: number; y: number } {
  if (z1 === z0) return p0;
  const t = 1 / z1 - 1 / z0;
  return { x: p0.x + ax * t, y: p0.y + ay * t };
}

function mapOverlayInverseScale(mapZoom: number): number {
  return 1 / Math.max(mapZoom, 0.01);
}

// ─── viewport edge ticks (rim labels that follow zoom/pan) ─────────────────────────────────

const MAP_FRAME_EDGE_SEGMENTS = 10;
type MapFrameTick = { pct: number; text: string };
type MapFrameTicks = {
  top: MapFrameTick[];
  bottom: MapFrameTick[];
  left: MapFrameTick[];
  right: MapFrameTick[];
};

function formatLonTick(lon: number): string {
  return `${normalizeLon(lon).toFixed(2)}°`;
}
function formatLatTick(lat: number): string {
  return `${Math.min(90, Math.max(-90, lat)).toFixed(2)}°`;
}

function buildViewportEdgeTicks(
  svg: SVGSVGElement,
  zr: DOMRectReadOnly,
  segments: number
): MapFrameTicks | null {
  if (segments < 2 || zr.width < 4 || zr.height < 4) return null;
  const inset = 3;
  const top: MapFrameTick[] = [];
  const bottom: MapFrameTick[] = [];
  const left: MapFrameTick[] = [];
  const right: MapFrameTick[] = [];
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const pct = t * 100;
    const x = zr.left + inset + t * (zr.width - 2 * inset);
    const y = zr.top + inset + t * (zr.height - 2 * inset);
    const gTop = clientToMapLatLon(svg, x, zr.top + inset);
    const gBot = clientToMapLatLon(svg, x, zr.bottom - inset);
    const gLef = clientToMapLatLon(svg, zr.left + inset, y);
    const gRig = clientToMapLatLon(svg, zr.right - inset, y);
    if (gTop) top.push({ pct, text: formatLonTick(gTop.lon) });
    if (gBot) bottom.push({ pct, text: formatLonTick(gBot.lon) });
    if (gLef) left.push({ pct, text: formatLatTick(gLef.lat) });
    if (gRig) right.push({ pct, text: formatLatTick(gRig.lat) });
  }
  return { top, bottom, left, right };
}

function navaidDotColor(kind: KerbinNavAidKind): string {
  if (kind === "VOR") return "#fb923c";
  if (kind === "ILS") return "#4ade80";
  return "#c4b5fd";
}

function KerbinMapFrameDegreesDynamic({
  ticks,
  mapZoom
}: {
  ticks: MapFrameTicks | null;
  mapZoom: number;
}): JSX.Element | null {
  if (!ticks) return null;
  const fs = Math.min(0.95, Math.max(0.62, 0.62 + Math.log2(Math.max(mapZoom, 0.35)) * 0.055));
  return (
    <div className="kerbin-map-viewport-degrees" aria-hidden style={{ fontSize: `${fs}rem` }}>
      <div className="kerbin-map-vdeg-lon kerbin-map-vdeg-lon--top">
        {ticks.top.map((tk, i) => (
          <span
            key={`vt-${i}-${tk.pct}`}
            className="kerbin-map-vdeg-tick kerbin-map-vdeg-tick--lon"
            style={{ left: `${tk.pct}%` }}
          >
            {tk.text}
          </span>
        ))}
      </div>
      <div className="kerbin-map-vdeg-lon kerbin-map-vdeg-lon--bottom">
        {ticks.bottom.map((tk, i) => (
          <span
            key={`vb-${i}-${tk.pct}`}
            className="kerbin-map-vdeg-tick kerbin-map-vdeg-tick--lon"
            style={{ left: `${tk.pct}%` }}
          >
            {tk.text}
          </span>
        ))}
      </div>
      <div className="kerbin-map-vdeg-lat kerbin-map-vdeg-lat--left">
        {ticks.left.map((tk, i) => (
          <span
            key={`vl-${i}-${tk.pct}`}
            className="kerbin-map-vdeg-tick kerbin-map-vdeg-tick--lat"
            style={{ top: `${tk.pct}%` }}
          >
            {tk.text}
          </span>
        ))}
      </div>
      <div className="kerbin-map-vdeg-lat kerbin-map-vdeg-lat--right">
        {ticks.right.map((tk, i) => (
          <span
            key={`vr-${i}-${tk.pct}`}
            className="kerbin-map-vdeg-tick kerbin-map-vdeg-tick--lat"
            style={{ top: `${tk.pct}%` }}
          >
            {tk.text}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── vessel icons ──────────────────────────────────────────────────────────────────────────

const VESSEL_ICON_STROKE = "rgba(15,23,42,0.95)";
const VESSEL_ICON_FILL = "#60a5fa";
const VESSEL_ICON_SW = 0.4;

export function vesselMapIconKind(t: Telemetry): CraftMapIcon {
  const m = t.craftMapIcon;
  if (m === "plane" || m === "rover" || m === "rocket") return m;
  if ((t.craftType ?? "").trim() === "Plane") return "plane";
  return "rocket";
}

function KerbinVesselMapGlyph({ kind }: { kind: CraftMapIcon }): JSX.Element {
  if (kind === "plane") {
    return (
      <path
        d="M0,-4.8 L0.55,-1.6 L4.8,1.4 L0.55,0.6 L0.5,2.4 L2.0,3.4 L0.4,3.0 L0.35,4.0 L-0.35,4.0 L-0.4,3.0 L-2.0,3.4 L-0.5,2.4 L-0.55,0.6 L-4.8,1.4 L-0.55,-1.6 Z"
        fill={VESSEL_ICON_FILL}
        stroke={VESSEL_ICON_STROKE}
        strokeWidth={VESSEL_ICON_SW}
        strokeLinejoin="round"
      />
    );
  }
  if (kind === "rover") {
    return (
      <>
        <rect
          x={-2.1}
          y={-2.8}
          width={4.2}
          height={5.6}
          rx={0.5}
          fill={VESSEL_ICON_FILL}
          stroke={VESSEL_ICON_STROKE}
          strokeWidth={VESSEL_ICON_SW}
        />
        <path
          d="M-1.4,-2.6 L0,-3.9 L1.4,-2.6 Z"
          fill={VESSEL_ICON_FILL}
          stroke={VESSEL_ICON_STROKE}
          strokeWidth={VESSEL_ICON_SW}
          strokeLinejoin="round"
        />
        <rect x={-2.95} y={-2.0} width={0.9} height={1.5} rx={0.18} fill={VESSEL_ICON_FILL} stroke={VESSEL_ICON_STROKE} strokeWidth={VESSEL_ICON_SW} />
        <rect x={2.05} y={-2.0} width={0.9} height={1.5} rx={0.18} fill={VESSEL_ICON_FILL} stroke={VESSEL_ICON_STROKE} strokeWidth={VESSEL_ICON_SW} />
        <rect x={-2.95} y={0.5} width={0.9} height={1.5} rx={0.18} fill={VESSEL_ICON_FILL} stroke={VESSEL_ICON_STROKE} strokeWidth={VESSEL_ICON_SW} />
        <rect x={2.05} y={0.5} width={0.9} height={1.5} rx={0.18} fill={VESSEL_ICON_FILL} stroke={VESSEL_ICON_STROKE} strokeWidth={VESSEL_ICON_SW} />
      </>
    );
  }
  return (
    <path
      d="M0,-4.8 L1.0,-2.0 L1.0,2.4 L2.6,4.2 L1.2,4.2 L1.2,4.4 L-1.2,4.4 L-1.2,4.2 L-2.6,4.2 L-1.0,2.4 L-1.0,-2.0 Z"
      fill={VESSEL_ICON_FILL}
      stroke={VESSEL_ICON_STROKE}
      strokeWidth={VESSEL_ICON_SW}
      strokeLinejoin="round"
    />
  );
}

function KerbinMapMarkerGroup({
  x,
  y,
  mapZoom,
  className,
  children
}: {
  x: number;
  y: number;
  mapZoom: number;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const iz = mapOverlayInverseScale(mapZoom);
  return (
    <g className={className} transform={`translate(${x},${y}) scale(${iz})`}>
      {children}
    </g>
  );
}

function KerbinVesselMapMarker({
  cx,
  cy,
  kind,
  mapZoom,
  headingDeg
}: {
  cx: number;
  cy: number;
  kind: CraftMapIcon;
  mapZoom: number;
  headingDeg?: number | null;
}): JSX.Element {
  const s = 1.28 * mapOverlayInverseScale(mapZoom);
  const rot =
    typeof headingDeg === "number" && Number.isFinite(headingDeg)
      ? ((headingDeg % 360) + 360) % 360
      : 0;
  return (
    <g
      transform={`translate(${cx},${cy}) scale(${s}) rotate(${rot})`}
      className="kerbin-map-vessel-marker"
      aria-hidden
    >
      <KerbinVesselMapGlyph kind={kind} />
    </g>
  );
}

const KKSC_AERODROME = KERBIN_AERODROMES.find((a) => a.id === "KKSC")!;

const TOWER_GUIDANCE_APPROACH_KM = 25;
const TOWER_GUIDANCE_CONE_HALF_DEG = 15;
const TOWER_GUIDANCE_KSC_RING_KM = [5, 10, 20, 30] as const;

/** KSC-centric rings, extended centerlines, and shallow final cones (tower overlay, not ILS avionics). */
function KerbinTowerGuidanceLayer({
  mapZoom,
  bodyRadiusKm,
  homeBaseLat,
  homeBaseLon,
  homeBodyName
}: {
  mapZoom: number;
  bodyRadiusKm: number;
  homeBaseLat: number;
  homeBaseLon: number;
  homeBodyName: string;
}): JSX.Element | null {
  if (homeBodyName.trim().toLowerCase() !== "kerbin") return null;
  const kksc = KKSC_AERODROME;
  const Rkm = bodyRadiusKm;
  const sw = 1.05 / mapZoom;

  const ringEls = TOWER_GUIDANCE_KSC_RING_KM.map((km) => {
    const degLat = (km / Rkm) * (180 / Math.PI);
    const cosLat = Math.max(0.05, Math.cos((homeBaseLat * Math.PI) / 180));
    const degLon = degLat / cosLat;
    const ry = degLat * (KERBIN_MAP_VB_H / 180);
    const rx = degLon * (KERBIN_MAP_VB_W / 360);
    const { x, y } = latLonToMapVB(homeBaseLat, homeBaseLon);
    return (
      <ellipse
        key={`tg-ring-${km}`}
        className="kerbin-map-tower-guidance-ring"
        cx={x}
        cy={y}
        rx={rx}
        ry={ry}
        fill="none"
        stroke="rgba(251, 191, 36, 0.55)"
        strokeWidth={sw}
        strokeDasharray={`${4 / mapZoom} ${3 / mapZoom}`}
      />
    );
  });

  return (
    <g className="kerbin-map-tower-guidance" pointerEvents="none">
      {ringEls}
      {kksc.runways.map((rwy) => {
        const thr = latLonToMapVB(rwy.thresholdLat, rwy.thresholdLon);
        const outBearing = rwy.headingDeg + 180;
        const far = projectLatLonBearing(
          rwy.thresholdLat,
          rwy.thresholdLon,
          outBearing,
          TOWER_GUIDANCE_APPROACH_KM,
          Rkm
        );
        const farVb = latLonToMapVB(far.lat, far.lon);
        const left = projectLatLonBearing(
          rwy.thresholdLat,
          rwy.thresholdLon,
          outBearing - TOWER_GUIDANCE_CONE_HALF_DEG,
          TOWER_GUIDANCE_APPROACH_KM,
          Rkm
        );
        const right = projectLatLonBearing(
          rwy.thresholdLat,
          rwy.thresholdLon,
          outBearing + TOWER_GUIDANCE_CONE_HALF_DEG,
          TOWER_GUIDANCE_APPROACH_KM,
          Rkm
        );
        const lv = latLonToMapVB(left.lat, left.lon);
        const rv = latLonToMapVB(right.lat, right.lon);
        return (
          <g key={`tg-cone-${rwy.designator}`}>
            <line
              x1={farVb.x}
              y1={farVb.y}
              x2={thr.x}
              y2={thr.y}
              stroke="#fbbf24"
              strokeOpacity={0.78}
              strokeWidth={1.35 / mapZoom}
              strokeDasharray={`${6 / mapZoom} ${4 / mapZoom}`}
            />
            <polygon
              points={`${thr.x},${thr.y} ${lv.x},${lv.y} ${rv.x},${rv.y}`}
              fill="rgba(251, 191, 36, 0.11)"
              stroke="rgba(251, 191, 36, 0.42)"
              strokeWidth={0.85 / mapZoom}
            />
          </g>
        );
      })}
    </g>
  );
}

function KerbinTowerAircraftStack({
  tracks,
  mapZoom,
  homeBodyName,
  bodyRadiusM,
  homeBaseLat,
  homeBaseLon,
  selfHeadingDeg
}: {
  tracks: readonly TowerAircraftTrack[];
  mapZoom: number;
  homeBodyName: string;
  bodyRadiusM: number;
  homeBaseLat: number;
  homeBaseLon: number;
  selfHeadingDeg: number | null;
}): JSX.Element {
  const homeLc = homeBodyName.toLowerCase();
  const isKerbin = homeLc === "kerbin";
  return (
    <g className="kerbin-map-tower-aircraft-stack">
      {tracks.map((tr) => {
        const t = tr.telemetry;
        if (t.lat == null || t.lon == null || (t.bodyName ?? "").toLowerCase() !== homeLc) return null;
        const { x: cx, y: cy } = latLonToMapVB(t.lat, t.lon);
        const effectiveHdg =
          tr.isSelf && selfHeadingDeg != null
            ? selfHeadingDeg
            : typeof t.heading === "number" && Number.isFinite(t.heading)
              ? t.heading
              : null;
        const distM = kerbinDistanceMeters(t.lat, t.lon, homeBaseLat, homeBaseLon, bodyRadiusM);
        const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM)} m`;
        const g = isKerbin
          ? computeKkscTowerGuidance({
              lat: t.lat,
              lon: t.lon,
              headingDeg: effectiveHdg ?? undefined,
              radarAltM: t.radarAlt,
              aslAltM: t.aslAlt,
              runwayPair: KKSC_AERODROME.runways,
              kscLat: homeBaseLat,
              kscLon: homeBaseLon,
              bodyRadiusM
            })
          : null;
        const altStr =
          t.radarAlt != null && Number.isFinite(t.radarAlt)
            ? `${Math.round(t.radarAlt)}`
            : t.aslAlt != null && Number.isFinite(t.aslAlt)
              ? `${Math.round(t.aslAlt)}`
              : "—";
        const gsStr = t.surfaceSpeed != null && Number.isFinite(t.surfaceSpeed) ? `${t.surfaceSpeed.toFixed(0)}` : "—";
        const hdgStr = effectiveHdg != null ? `${effectiveHdg.toFixed(0)}` : "—";
        const situationLc = (t.situation ?? "").toLowerCase();
        const onGroundSituation =
          situationLc === "landed" ||
          situationLc === "splashed" ||
          situationLc === "prelaunch" ||
          situationLc === "docked";
        const appStr =
          g == null
            ? "—"
            : onGroundSituation
              ? "—"
              : g.onApproach
                ? "YES"
                : "NO";
        const alignStr = g && !onGroundSituation ? g.align : "—";
        const glideStr = g && !onGroundSituation ? g.glide : "—";
        const lh = 1.65;
        return (
          <g key={tr.id}>
            <KerbinVesselMapMarker
              cx={cx}
              cy={cy}
              kind={vesselMapIconKind(t)}
              mapZoom={mapZoom}
              headingDeg={effectiveHdg}
            />
            <KerbinMapMarkerGroup
              x={cx + 5}
              y={cy - 3}
              mapZoom={mapZoom}
              className={"kerbin-tower-aircraft-label" + (tr.isSelf ? " kerbin-tower-aircraft-label--self" : "")}
            >
              <text className="kerbin-tower-aircraft-label__text" x={0} y={0} fontWeight={700}>
                {tr.label.toUpperCase()}
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh}>
                ALT {altStr} m
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 2}>
                GS {gsStr} m/s
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 3}>
                HDG {hdgStr}°
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 4}>
                DIST KSC {distStr}
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 5}>
                APP: {appStr}
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 6}>
                ALIGN: {alignStr}
              </text>
              <text className="kerbin-tower-aircraft-label__text" x={0} y={lh * 7}>
                GLIDE: {glideStr}
              </text>
            </KerbinMapMarkerGroup>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Native-SVG ILS approach layer: vector geometry from `KERBIN_AERODROMES`,
 * computed ILS markers, and `KKSC_ILS_GEOMETRY` so runways, extended
 * centerlines, and OM/MM/IM markers scale with the map. Lines are drawn in geo
 * coords (a 2.5 km runway is 2.5 km on screen at runway zoom). Marker beacons +
 * labels counter-scale via `mapOverlayInverseScale` so they stay legible at
 * every zoom — same trick the navaid pins use.
 */
function KerbinApproachLayer({
  aerodromes,
  markers,
  bodyRadiusKm,
  mapZoom
}: {
  aerodromes: readonly KerbinAerodrome[];
  markers: readonly KerbinIlsMarker[];
  bodyRadiusKm: number;
  mapZoom: number;
}): JSX.Element {
  return (
    <g className="kerbin-map-approaches" pointerEvents="none">
      {aerodromes.map((aero) => (
        <KerbinAerodromeApproach
          key={aero.id}
          aerodrome={aero}
          markers={markers.filter((m) => m.aerodrome === aero.id)}
          bodyRadiusKm={bodyRadiusKm}
          mapZoom={mapZoom}
        />
      ))}
    </g>
  );
}

/**
 * Small "open aerodrome diagram" buttons, one per aerodrome. Opens the vector
 * detail modal (frequencies + runway sketch).
 */
function KerbinAerodromeChartButtons({
  aerodromes,
  mapZoom,
  onOpen
}: {
  aerodromes: readonly KerbinAerodrome[];
  mapZoom: number;
  onOpen: (aerodromeId: KerbinAerodrome["id"]) => void;
}): JSX.Element {
  return (
    // pointer-events: auto re-enables hit-testing inside .kerbin-map-overlay-svg,
    // which sets pointer-events: none on the parent so the basemap pan/click-pick
    // pipeline works. We stop pointerdown propagation so clicking the button
    // doesn't also kick off the pan-drag tracker on the parent map.
    <g className="kerbin-map-aerodrome-chart-buttons" style={{ pointerEvents: "auto" }}>
      {aerodromes.map((aero) => {
          const { x, y } = latLonToMapVB(aero.refLat, aero.refLon);
          return (
            <KerbinMapMarkerGroup key={`chartbtn-${aero.id}`} x={x} y={y} mapZoom={mapZoom}>
              {/* Offset diagonally up-right of the aerodrome ref-point label
               * (which itself sits at translate(3.5, -3.5)) so the button
               * doesn't cover the runway polygon when approaches are on. */}
              <g
                transform="translate(8.6, -3.5)"
                className="kerbin-map-aerodrome-chart-button"
                role="button"
                tabIndex={0}
                aria-label={`Open ${aero.id} aerodrome diagram`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(aero.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(aero.id);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <title>Open {aero.id} aerodrome diagram</title>
                <rect
                  x={-2.6}
                  y={-2.6}
                  width={5.2}
                  height={3.4}
                  rx={0.5}
                  fill="rgba(15,23,42,0.85)"
                  stroke="#fde68a"
                  strokeWidth={0.25}
                />
                <text
                  x={0}
                  y={0}
                  textAnchor="middle"
                  fontSize="2"
                  fontWeight={700}
                  fill="#fde68a"
                  style={{ pointerEvents: "none" }}
                >
                  PLT
                </text>
              </g>
            </KerbinMapMarkerGroup>
          );
        })}
    </g>
  );
}

function KerbinAerodromeApproach({
  aerodrome,
  markers,
  bodyRadiusKm,
  mapZoom
}: {
  aerodrome: KerbinAerodrome;
  markers: readonly KerbinIlsMarker[];
  bodyRadiusKm: number;
  mapZoom: number;
}): JSX.Element {
  // Runway width parsed from the printed `runwaySpec` ("2500 x 60 CONCRETE")
  // — falls back to 30 m for the grass strips that don't bother to print one.
  const widthM = (() => {
    const m = /\d+\s*x\s*(\d+)/i.exec(aerodrome.runwaySpec);
    if (m && m[1]) return Math.max(15, parseInt(m[1], 10));
    return 30;
  })();
  const widthKm = widthM / 1000;
  // Visual width inflation: the as-built 60 m strip is ~0.1 vb units wide and
  // disappears unless the user is zoomed in past 8x. We render the runway at
  // the true geometric width AND draw a thin centerline on top so it's still
  // recognizable at moderate zoom levels.
  const widthDegLat = (widthKm / bodyRadiusKm) * (180 / Math.PI);
  const widthVbY = widthDegLat * (KERBIN_MAP_VB_H / 180);

  // The runway polygon connects the two thresholds; we widen it perpendicular
  // to the runway heading using the magnetic heading of the "09" runway
  // (or the first runway listed, if "09" isn't there).
  const rwy09 = aerodrome.runways.find((r) => r.designator === "09") ?? aerodrome.runways[0];
  const rwy27 = aerodrome.runways.find((r) => r.designator === "27") ?? aerodrome.runways[1];

  const toVb = (lat: number, lon: number): { x: number; y: number } => latLonToMapVB(lat, lon);

  const aerodromeLabelXY = toVb(aerodrome.refLat, aerodrome.refLon);

  return (
    <g className={`kerbin-map-approach kerbin-map-approach-${aerodrome.id.toLowerCase()}`}>
      {rwy09 && rwy27 ? (() => {
        const a = toVb(rwy09.thresholdLat, rwy09.thresholdLon);
        const b = toVb(rwy27.thresholdLat, rwy27.thresholdLon);
        // Perpendicular vector in viewBox space (note the y-axis is flipped).
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = (-dy / len) * (widthVbY / 2);
        const py = (dx / len) * (widthVbY / 2);
        return (
          <polygon
            points={`${a.x + px},${a.y + py} ${b.x + px},${b.y + py} ${b.x - px},${b.y - py} ${a.x - px},${a.y - py}`}
            fill="rgba(15,23,42,0.85)"
            stroke="#f8fafc"
            strokeWidth={0.8 / mapZoom}
          />
        );
      })() : null}

      {/* Per-runway approach: extended dashed centerline behind the threshold
       * + missed-approach turn dot ahead of the threshold. We always draw 12
       * km of approach so both KKSC (where the OM sits 8.3 km out) and KAFD
       * (only an IM, ~150 m out) get a legible final-approach line. */}
      {aerodrome.runways.map((rwy) => {
        const thr = toVb(rwy.thresholdLat, rwy.thresholdLon);
        const approachStart = projectLatLonBearing(
          rwy.thresholdLat,
          rwy.thresholdLon,
          rwy.headingDeg + 180,
          12,
          bodyRadiusKm
        );
        const approachStartVb = toVb(approachStart.lat, approachStart.lon);
        const missedTurn = projectLatLonBearing(
          rwy.thresholdLat,
          rwy.thresholdLon,
          rwy.headingDeg,
          KKSC_ILS_GEOMETRY.missedApproachTurnDmeKm,
          bodyRadiusKm
        );
        const missedTurnVb = toVb(missedTurn.lat, missedTurn.lon);
        return (
          <g key={`${aerodrome.id}-${rwy.designator}`}>
            <line
              x1={approachStartVb.x}
              y1={approachStartVb.y}
              x2={thr.x}
              y2={thr.y}
              stroke="#4ade80"
              strokeOpacity={0.7}
              strokeWidth={1.3 / mapZoom}
              strokeDasharray={`${6 / mapZoom} ${4 / mapZoom}`}
            />
            {/* 1 km tick marks along the centerline so distance-to-threshold is
             * eyeballable without overlaying a distance ring. Each tick is a
             * counter-scaled marker so its on-screen length stays readable at
             * every zoom — at 1500x the geometry-scaled version would have
             * been many viewport-widths long. We also rotate by the runway
             * heading so the tick is perpendicular to the centerline, then
             * lengthen every 5th tick + label its DME so 5/10 km are obvious. */}
            {Array.from({ length: 12 }, (_, i) => i + 1).map((km) => {
              const tick = projectLatLonBearing(
                rwy.thresholdLat,
                rwy.thresholdLon,
                rwy.headingDeg + 180,
                km,
                bodyRadiusKm
              );
              const tickVb = toVb(tick.lat, tick.lon);
              const major = km % 5 === 0;
              const half = major ? 2.6 : 1.4;
              return (
                <KerbinMapMarkerGroup
                  key={`tick-${km}`}
                  x={tickVb.x}
                  y={tickVb.y}
                  mapZoom={mapZoom}
                >
                  <g transform={`rotate(${rwy.headingDeg + 90})`}>
                    <line
                      x1={-half}
                      y1={0}
                      x2={half}
                      y2={0}
                      stroke="#4ade80"
                      strokeOpacity={major ? 0.9 : 0.5}
                      strokeWidth={major ? 0.6 : 0.4}
                    />
                    {major ? (
                      <text
                        x={half + 0.6}
                        y={0.55}
                        fontSize="1.6"
                        fill="#4ade80"
                        fillOpacity={0.9}
                        transform={`rotate(${-(rwy.headingDeg + 90)})`}
                      >
                        {km}
                      </text>
                    ) : null}
                  </g>
                </KerbinMapMarkerGroup>
              );
            })}
            {/* Missed-approach turn point: small empty triangle pointing along
             * the runway heading at the published 5 km DME from threshold. */}
            <KerbinMapMarkerGroup x={missedTurnVb.x} y={missedTurnVb.y} mapZoom={mapZoom}>
              <g
                transform={`rotate(${rwy.headingDeg})`}
                className="kerbin-map-approach-mapt"
              >
                <polygon
                  points="0,-2.4 2.0,1.6 -2.0,1.6"
                  fill="none"
                  stroke="#fb923c"
                  strokeWidth={0.45}
                />
                <text
                  x={0}
                  y={4.6}
                  textAnchor="middle"
                  fontSize="2.3"
                  fill="#fb923c"
                  transform={`rotate(${-rwy.headingDeg})`}
                >
                  MAPt
                </text>
              </g>
            </KerbinMapMarkerGroup>
          </g>
        );
      })}

      {/* OM / MM / IM marker beacons (`kerbinIlsMarkersComputed`), zoom-counter-
       * scaled lozenges with the position letter inside. Colors: OM cyan,
       * MM amber, IM white. */}
      {markers.map((m) => {
        const v = toVb(m.lat, m.lon);
        const fill =
          m.position === "OM" ? "#38bdf8" : m.position === "MM" ? "#fb923c" : "#e2e8f0";
        return (
          <KerbinMapMarkerGroup key={m.id} x={v.x} y={v.y} mapZoom={mapZoom}>
            <ellipse
              cx={0}
              cy={0}
              rx={2.2}
              ry={1.2}
              fill={fill}
              stroke="rgba(15,23,42,0.9)"
              strokeWidth={0.35}
            />
            <text
              x={0}
              y={0.55}
              textAnchor="middle"
              fontSize="1.6"
              fontWeight={700}
              fill="rgba(15,23,42,0.9)"
            >
              {m.position}
            </text>
          </KerbinMapMarkerGroup>
        );
      })}

      {/* Aerodrome ID / runway spec label, anchored on the aerodrome reference
       * point. Counter-scaled so it's the same on-screen size at every zoom. */}
      <KerbinMapMarkerGroup x={aerodromeLabelXY.x} y={aerodromeLabelXY.y} mapZoom={mapZoom}>
        <g transform="translate(3.5, -3.5)">
          <rect
            x={-0.6}
            y={-2.6}
            width={`${aerodrome.id.length * 1.45 + 1.2}`}
            height={3.4}
            rx={0.4}
            fill="rgba(15,23,42,0.78)"
            stroke="rgba(248,250,252,0.4)"
            strokeWidth={0.2}
          />
          <text
            x={0}
            y={0}
            fontSize="2.4"
            fontWeight={700}
            fill="#f8fafc"
          >
            {aerodrome.id}
          </text>
        </g>
      </KerbinMapMarkerGroup>
    </g>
  );
}

function KerbinVesselChartKeyIcon({ kind }: { kind: CraftMapIcon }): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="-6 -6 12 12"
      className="kerbin-map-chart-key-vessel-svg"
      aria-hidden
    >
      <KerbinVesselMapGlyph kind={kind} />
    </svg>
  );
}

// ─── compact in-map legend ─────────────────────────────────────────────────────────────────

type LegendBand = { label: string; color: string };

// Hypsometric tints for the schematic alt layer — legend swatches should match the SVG fills.
const ALT_LEGEND: LegendBand[] = [
  { label: "Below sea level", color: "#082f49" },
  { label: "0 – 100 m", color: "#134e2a" },
  { label: "100 – 500 m", color: "#3f6b2a" },
  { label: "500 – 2500 m", color: "#8b5a3c" },
  { label: "2500 – 4000 m", color: "#78716c" },
  { label: "4000 m+", color: "#e7e5e4" }
];

// Vegetation-keyed proxy for bundled biome-tint SVGs. Not a real
// KSP biome list — that comes from the live `body.BiomeMap` whose actual category names + colours
// would replace this when the plugin's per-biome palette ships.
const BIOME_PROXY_LEGEND: LegendBand[] = [
  { label: "Water", color: "#0c4a6e" },
  { label: "Forest", color: "#14532d" },
  { label: "Grassland", color: "#65a30d" },
  { label: "Arid / desert", color: "#a16207" },
  { label: "Alpine / rock", color: "#78716c" },
  { label: "Snow / ice", color: "#e7e5e4" }
];

// Steepness ramp for bundled slope-tint SVGs. Same caveat: this is
// an elevation-derived proxy, not the true PQS surface gradient.
const SLOPE_PROXY_LEGEND: LegendBand[] = [
  { label: "Flat", color: "#0ea5e9" },
  { label: "Gentle", color: "#10b981" },
  { label: "Moderate", color: "#facc15" },
  { label: "Steep", color: "#f97316" },
  { label: "Very steep", color: "#dc2626" }
];

// ─── click-pick samplers (biome / slope at lat-lon) ────────────────────────────────────────
//
// Goal: when the operator clicks the map, show a one-line proxy biome label + a one-line proxy
// slope label next to the lat/lon readout. We do this by rasterising the active biome / slope
// layer URL onto an offscreen canvas once, then sampling RGBA at (u, v) on click.
//
// Why proxies (not live data): the plugin's live biome PNG is `body.BiomeMap` — its colours are
// `CBAttributeMapSO.Attributes` (per-pack, per-body) which we don't have a frontend lookup for.
// And the plugin doesn't yet bake live slope at all (see TowerBasemapBaker.cs). The proxies
// give the operator a useful at-a-glance terrain class today; when live palettes ship, this is
// where the lookup would branch on `worldMaps.layers.find(l => l.id === "biome").url`.

type RgbSample = { r: number; g: number; b: number; a: number };
type RgbSampler = (u: number, v: number) => RgbSample | null;

// Module-level cache: one promise per URL so concurrent click-picks share the rasterisation.
// Survives component remounts (which happen on basemap-layer toggles) so we don't re-decode the
// SVG every time the operator flips between layers.
const samplerCache = new Map<string, Promise<RgbSampler | null>>();

// 1024×512 keeps each sample within ~0.35° of the click — finer than the bands' visible width on
// the SVG layer (702.25×351.5 source viewBox for Earth hypsometry layers, so this oversamples ~1.5×).
// Bigger canvases waste memory; smaller ones bleed across band boundaries on coastlines.
const SAMPLER_W = 1024;
const SAMPLER_H = 512;

function loadRgbSampler(url: string): Promise<RgbSampler | null> {
  const cached = samplerCache.get(url);
  if (cached) return cached;
  const p: Promise<RgbSampler | null> = (async () => {
    try {
      const img = new Image();
      // Same-origin in dev (Vite proxy) and prod (basemaps served by the same host); the explicit
      // attribute keeps `getImageData` from tainting the canvas if the browser reaches a CDN
      // edge that doesn't echo the origin header on its own.
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`sampler load failed: ${url}`));
      });
      img.src = url;
      await loaded;
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLER_W;
      canvas.height = SAMPLER_H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      // Stretch-to-fill: equirect mapping covers the full canvas edge-to-edge so (u, v) directly
      // index into the pixel grid without any letterbox math.
      ctx.drawImage(img, 0, 0, SAMPLER_W, SAMPLER_H);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, SAMPLER_W, SAMPLER_H).data;
      } catch {
        // Tainted canvas (cross-origin without CORS echo) — give up gracefully.
        return null;
      }
      return (u: number, v: number) => {
        if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
        const cu = Math.max(0, Math.min(0.9999999, u));
        const cv = Math.max(0, Math.min(0.9999999, v));
        const x = Math.floor(cu * SAMPLER_W);
        const y = Math.floor(cv * SAMPLER_H);
        const i = (y * SAMPLER_W + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
        return { r, g, b, a };
      };
    } catch {
      return null;
    }
  })();
  samplerCache.set(url, p);
  return p;
}

// Per-band metadata for schematic biome / slope proxy plates (deep water → mountain bands).
type ProxyBand = { label: string; hex: string };

const BIOME_PROXY_BANDS: readonly ProxyBand[] = [
  { hex: "#234e6e", label: "Deep ocean" },
  { hex: "#3a7596", label: "Shelf / coast" },
  { hex: "#aac98c", label: "Coastal plain" },
  { hex: "#3f7a3e", label: "Forest / lowland" },
  { hex: "#bca35e", label: "Grassland" },
  { hex: "#b07a3a", label: "Arid highland" },
  { hex: "#9aa098", label: "Alpine / tundra" }
];

const SLOPE_PROXY_BANDS: readonly ProxyBand[] = [
  { hex: "#1f3a4a", label: "Flat (sea floor)" },
  { hex: "#2f5a73", label: "Near flat (shelf)" },
  { hex: "#3d8f7a", label: "Gentle (coast)" },
  { hex: "#5fa86b", label: "Mild (lowland)" },
  { hex: "#d6c042", label: "Moderate (uplands)" },
  { hex: "#e07b2a", label: "Steep (highland)" },
  { hex: "#c12d1d", label: "Very steep (mountain)" }
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

// Pre-compute palette RGB so we're not parsing hex on every click.
const BIOME_PROXY_RGB = BIOME_PROXY_BANDS.map((b) => ({ ...hexToRgb(b.hex), label: b.label }));
const SLOPE_PROXY_RGB = SLOPE_PROXY_BANDS.map((b) => ({ ...hexToRgb(b.hex), label: b.label }));

/**
 * Find the palette entry whose colour is closest (Euclidean distance in RGB) to the sampled pixel.
 * Returns null when the sample is null/transparent OR the nearest distance is so high the pixel
 * almost certainly isn't a band fill (label glyph, graticule line, runway marking) — those should
 * read as "—" in the UI rather than mis-classifying.
 */
function nearestBandLabel(
  sample: RgbSample | null,
  palette: ReadonlyArray<{ r: number; g: number; b: number; label: string }>
): string | null {
  if (!sample || sample.a < 16) return null;
  let best: (typeof palette)[number] | undefined;
  let bestD2 = Infinity;
  for (const band of palette) {
    const dr = sample.r - band.r;
    const dg = sample.g - band.g;
    const db = sample.b - band.b;
    const d2 = dr * dr + dg * dg + db * db;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = band;
    }
  }
  // A perfect band fill yields d2 == 0; the cap (~80²) admits anti-aliased band edges but
  // rejects decorative annotation strokes in the Earth hypsometry SVG (#1e293b / pure white / red).
  if (!best || bestD2 > 80 * 80) return null;
  return best.label;
}

// ─── decimal-degrees → DMS helper ──────────────────────────────────────────────────────────
//
// Pilots often expect degrees-minutes-seconds (aviation convention). We render both: decimal stays
// the headline (same format KSP reports in the F2 surface readout); DMS on a second line for a quick human cross-check.
function formatDms(deg: number, posChar: "N" | "E", negChar: "S" | "W"): string {
  if (!Number.isFinite(deg)) return "—";
  const sign = deg >= 0 ? posChar : negChar;
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = (minFloat - m) * 60;
  // 1 second of arc on Kerbin ≈ 2.9 m at the equator — rounding to whole seconds keeps the
  // display compact without losing useful precision for a click pick (the click target itself is
  // already nowhere near sub-second).
  return `${sign} ${d}°${m.toString().padStart(2, "0")}'${Math.round(s)
    .toString()
    .padStart(2, "0")}"`;
}

type LegendState = {
  /** Heading shown next to the toggle so the user can see what they're looking at. */
  title: string;
  /** Either a categorical swatch list, or null when the layer is a continuous live photo. */
  bands: LegendBand[] | null;
  /** Caveat / source attribution shown below the swatches. */
  note: string;
};

function legendStateFor(
  layer: BasemapLayerPref,
  isLive: boolean,
  liveBodyDisplay: string | null
): LegendState {
  if (layer === "schematic") {
    return {
      title: "Schematic (alt-tinted)",
      bands: ALT_LEGEND,
      note: "Bundled schematic vector hypsometry. Sharp at any zoom."
    };
  }
  if (layer === "alt") {
    return isLive
      ? {
          title: `Altimetry · live ${liveBodyDisplay ?? ""}`.trim(),
          // The live alt PNG is the scaledSpace `_MainTex` — a continuous photo-style colour
          // texture, not a categorical hypsometric map. Showing band swatches over a photo
          // would lie about the data, so we omit them and explain instead.
          bands: null,
          note: "Live KSP scaled-space colour texture. Continuous photo-style imagery, not categorical bands."
        }
      : {
          title: "Altimetry · static fallback",
          bands: ALT_LEGEND,
          note: "Bundled hypsometric tints — start KSP for the live in-game altitude bake."
        };
  }
  if (layer === "biome") {
    return isLive
      ? {
          title: `Biomes · live ${liveBodyDisplay ?? ""}`.trim(),
          // Without the plugin shipping the actual `CBAttributeMapSO.Attributes` palette, we
          // can't render the real KSP categories here — the proxy palette below is the closest
          // approximation and still serves as a colour key for the rough zones visible in the PNG.
          bands: BIOME_PROXY_LEGEND,
          note: "Live KSP biome map. Actual category names come from the in-game CBAttributeMapSO; swatches below are a proxy."
        }
      : {
          title: "Biomes · static proxy",
          bands: BIOME_PROXY_LEGEND,
          note: "Vegetation-tinted proxy keyed to elevation bands — start KSP for the real biome map."
        };
  }
  // slope
  return isLive
    ? {
        title: `Slope · live ${liveBodyDisplay ?? ""}`.trim(),
        bands: SLOPE_PROXY_LEGEND,
        note: "Live PQS slope bake."
      }
    : {
        title: "Slope · static proxy",
        bands: SLOPE_PROXY_LEGEND,
        note: "Steepness proxy keyed to elevation bands — no live PQS slope bake yet."
      };
}

function KerbinMapLegend({
  layer,
  isLive,
  liveBodyDisplay
}: {
  layer: BasemapLayerPref;
  isLive: boolean;
  liveBodyDisplay: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const state = legendStateFor(layer, isLive, liveBodyDisplay);
  const lo = state.bands?.[0]?.label ?? "";
  const hi = state.bands?.[state.bands.length - 1]?.label ?? "";
  return (
    <div
      className={`tower-map-legend${open ? "" : " tower-map-legend--collapsed"}`}
      role="note"
      aria-label="Map legend"
    >
      <button
        type="button"
        className="tower-map-legend-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide legend" : "Show legend"}
      >
        {state.title} {open ? "−" : "+"}
      </button>
      {open ? (
        <div className="tower-map-legend-body">
          {state.bands ? (
            <div className="tower-map-legend-hypso" aria-label={`${state.title} swatches`}>
              {state.bands.map((b) => (
                <span
                  key={b.label}
                  className="tower-map-legend-hypso-cell"
                  style={{ background: b.color }}
                  title={b.label}
                />
              ))}
              <span className="tower-map-legend-hypso-range" aria-hidden>
                <span>{lo}</span>
                <span>{hi}</span>
              </span>
            </div>
          ) : null}
          <p className="tower-map-legend-note">{state.note}</p>
          <ul className="tower-map-legend-glyphs">
            <li><span className="tower-map-legend-dot" style={{ background: "#fb923c" }} />VOR</li>
            <li><span className="tower-map-legend-dot" style={{ background: "#4ade80" }} />ILS</li>
            <li><span className="tower-map-legend-dot" style={{ background: "#c4b5fd" }} />NDB</li>
            <li><span className="tower-map-legend-dot" style={{ background: "#f59e0b" }} />KSC</li>
            <li>
              <span
                className="tower-map-legend-dot tower-map-legend-tri"
                style={{ background: "#38bdf8" }}
              />
              Sites
            </li>
            <li>
              <span
                className="tower-map-legend-dot tower-map-legend-anomaly"
                style={{ background: "#a78bfa" }}
              />
              Anomalies
            </li>
            <li className="tower-map-legend-vessel-li">
              <span className="tower-map-legend-vessel-icons" aria-hidden>
                <KerbinVesselChartKeyIcon kind="plane" />
                <KerbinVesselChartKeyIcon kind="rocket" />
                <KerbinVesselChartKeyIcon kind="rover" />
              </span>
              Vessel
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ─── marker click pick + modal ─────────────────────────────────────────────────────────────

type KerbinMapMarkerModalState =
  | { kind: "navaid"; n: KerbinNavAid }
  | { kind: "ksc"; lat: number; lon: number; bodyName: string }
  | { kind: "site"; s: KerbinLaunchSite }
  | { kind: "vessel"; t: Telemetry };

type KerbinMapMarkerHit = KerbinMapMarkerModalState & { dist: number };

function pickKerbinMapMarkerAtClient(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  opts: {
    mapShowVor: boolean;
    mapShowIls: boolean;
    mapShowNdb: boolean;
    mapShowKsc: boolean;
    mapShowSites: boolean;
    /** Vessels eligible for click-pick on the current map body (already filtered). */
    vesselTargets: readonly Telemetry[];
    navaids: readonly KerbinNavAid[];
    launchSites: readonly KerbinLaunchSite[];
    kscLat: number;
    kscLon: number;
    homeBodyName: string;
  }
): KerbinMapMarkerModalState | null {
  const candidates: KerbinMapMarkerHit[] = [];
  for (const n of opts.navaids) {
    const show =
      n.kind === "VOR" ? opts.mapShowVor : n.kind === "ILS" ? opts.mapShowIls : opts.mapShowNdb;
    if (!show) continue;
    const { x, y } = latLonToMapVB(n.lat, n.lon);
    const scr = mapVBPointToClient(svg, x, y);
    if (!scr) continue;
    const dist = Math.hypot(scr.x - clientX, scr.y - clientY);
    candidates.push({ kind: "navaid", n, dist });
  }
  if (opts.mapShowKsc) {
    const { x, y } = latLonToMapVB(opts.kscLat, opts.kscLon);
    const scr = mapVBPointToClient(svg, x, y);
    if (scr)
      candidates.push({
        kind: "ksc",
        lat: opts.kscLat,
        lon: opts.kscLon,
        bodyName: opts.homeBodyName,
        dist: Math.hypot(scr.x - clientX, scr.y - clientY)
      });
  }
  if (opts.mapShowSites) {
    for (const s of opts.launchSites) {
      const { x, y } = latLonToMapVB(s.lat, s.lon);
      const scr = mapVBPointToClient(svg, x, y);
      if (!scr) continue;
      candidates.push({ kind: "site", s, dist: Math.hypot(scr.x - clientX, scr.y - clientY) });
    }
  }
  for (const t of opts.vesselTargets) {
    if (t.lat == null || t.lon == null) continue;
    const { x, y } = latLonToMapVB(t.lat, t.lon);
    const scr = mapVBPointToClient(svg, x, y);
    if (scr)
      candidates.push({
        kind: "vessel",
        t,
        dist: Math.hypot(scr.x - clientX, scr.y - clientY)
      });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  const best = candidates[0];
  if (!best || best.dist > MAP_MARKER_HIT_PX) return null;
  if (best.kind === "navaid") return { kind: "navaid", n: best.n };
  if (best.kind === "ksc") return { kind: "ksc", lat: best.lat, lon: best.lon, bodyName: best.bodyName };
  if (best.kind === "site") return { kind: "site", s: best.s };
  return { kind: "vessel", t: best.t };
}

function formatNavaidFrequency(n: KerbinNavAid): string {
  if (n.kind === "NDB") return `${n.frequency} kHz`;
  return `${n.frequency} MHz`;
}

type MarkerSubjectWorldStatus = "same-world" | "different-world" | "no-viewer-world";

function describeSubjectWorld(
  bodyName: string | undefined,
  viewerWorld: WorldInventory | null,
  catalog: SystemCatalog | null
): MarkerSubjectWorldStatus {
  if (!viewerWorld) return "no-viewer-world";
  if (catalog && bodyName) {
    const hit = bodyByName(catalog, bodyName);
    if (hit) return "same-world";
    return "different-world";
  }
  return "same-world";
}

function WorldBadgeRow({
  viewerWorld,
  status,
  subjectBodyDisplay
}: {
  viewerWorld: WorldInventory | null;
  status: MarkerSubjectWorldStatus;
  subjectBodyDisplay: string;
}): JSX.Element | null {
  if (!viewerWorld) return null;
  const worldLabel = viewerWorld.home.displayName || viewerWorld.home.name;
  const badgeLabel =
    status === "different-world"
      ? "Different world"
      : status === "no-viewer-world"
        ? "Unknown world"
        : "Same world";
  const badgeClass = `world-badge world-badge-${status}`;
  return (
    <div>
      <dt>World</dt>
      <dd>
        <span className={badgeClass}>{badgeLabel}</span>{" "}
        <span className="world-badge-name">
          {worldLabel} <span className="world-badge-id">({viewerWorld.worldId})</span>
        </span>
        {status === "different-world" ? (
          <div className="world-badge-note">
            Subject is on <strong>{subjectBodyDisplay}</strong>, which isn’t in this world’s body
            catalog. Marker actions are limited.
          </div>
        ) : null}
      </dd>
    </div>
  );
}

function BodyContextRow({
  bodyName,
  catalog
}: {
  bodyName: string | undefined;
  catalog: SystemCatalog | null;
}): JSX.Element | null {
  if (!bodyName || !catalog) return null;
  const body = bodyByName(catalog, bodyName);
  if (!body) return null;
  const radiusKm = (body.radiusM / 1000).toFixed(0);
  const atmoBit = body.hasAtmosphere
    ? body.atmosphereDepthM != null
      ? `atm to ${(body.atmosphereDepthM / 1000).toFixed(0)} km`
      : "has atmosphere"
    : "no atmosphere";
  return (
    <div>
      <dt>Body context</dt>
      <dd>
        <strong>{body.displayName}</strong>
        {body.parent ? (
          <>
            {" "}
            orbiting <em>{body.parent}</em>
          </>
        ) : null}
        <div className="kerbin-map-marker-body-stats">
          radius {radiusKm} km · {atmoBit}
        </div>
      </dd>
    </div>
  );
}

/**
 * Display labels for Kerbalism life-support resources surfaced on the marker
 * modal (KERBALISM_TELEMETRY_PLAN.md Phase 4, brought forward). Mirrors the
 * map declared in TowerDesk.tsx; kept duplicated rather than exported because
 * the two surfaces drift independently (the modal is denser and may want
 * shorter labels in future).
 */
const KERBALISM_LS_LABEL: Record<string, string> = {
  food: "Food",
  water: "Water",
  oxygen: "O₂",
  nitrogen: "N₂",
  atmosphere: "Atmosphere",
  wasteAtmosphere: "Waste atmo",
  carbonDioxide: "CO₂"
};

function KerbinMapMarkerModalView({
  state,
  onClose,
  viewerWorld,
  catalog
}: {
  state: KerbinMapMarkerModalState;
  onClose: () => void;
  viewerWorld: WorldInventory | null;
  catalog: SystemCatalog | null;
}): JSX.Element {
  const titleId = "kerbin-map-marker-modal-title";
  return (
    <div
      className="kerbin-map-marker-modal-root"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="kerbin-map-marker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kerbin-map-marker-modal-head">
          <h3 id={titleId} className="kerbin-map-marker-modal-title">
            {state.kind === "navaid"
              ? `${state.n.id} · ${state.n.name}`
              : state.kind === "ksc"
                ? state.bodyName.toLowerCase() === "kerbin"
                  ? "Kerbal Space Center"
                  : `Home base · ${state.bodyName}`
                : state.kind === "site"
                  ? `${state.s.id} · ${state.s.name}`
                  : [aircraftPrimaryLabel(state.t), state.t.craftType].filter(Boolean).join(" · ")}
          </h3>
          <button
            type="button"
            className="kerbin-map-marker-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="kerbin-map-marker-modal-body">
          {state.kind === "navaid" ? (
            <dl className="kerbin-map-marker-modal-dl">
              <div><dt>Type</dt><dd>{state.n.kind}</dd></div>
              <div><dt>Frequency</dt><dd>{formatNavaidFrequency(state.n)}</dd></div>
              <div><dt>Latitude</dt><dd>{state.n.lat.toFixed(5)}°</dd></div>
              <div><dt>Longitude</dt><dd>{state.n.lon.toFixed(5)}°</dd></div>
              <p className="kerbin-map-marker-modal-note">From the MAS navaid list (game lat/lon).</p>
            </dl>
          ) : null}
          {state.kind === "ksc" ? (
            <dl className="kerbin-map-marker-modal-dl">
              <div><dt>Body</dt><dd>{state.bodyName}</dd></div>
              <div><dt>Latitude</dt><dd>{state.lat.toFixed(5)}°</dd></div>
              <div><dt>Longitude</dt><dd>{state.lon.toFixed(5)}°</dd></div>
              <p className="kerbin-map-marker-modal-note">
                {state.bodyName.toLowerCase() === "kerbin"
                  ? "MAS CENTER (KST) — same coords as the navaid list; distance readouts use this point."
                  : "Home base on the active world (resolved from the live KSP install). Distance readouts use this point."}
              </p>
            </dl>
          ) : null}
          {state.kind === "site" ? (
            <dl className="kerbin-map-marker-modal-dl">
              <div>
                <dt>Source</dt>
                <dd>{state.s.source === "stock" ? "Stock KSP" : "Making History DLC"}</dd>
              </div>
              <div><dt>Latitude</dt><dd>{state.s.lat.toFixed(5)}°</dd></div>
              <div><dt>Longitude</dt><dd>{state.s.lon.toFixed(5)}°</dd></div>
              {state.s.blurb ? (
                <p className="kerbin-map-marker-modal-note">{state.s.blurb}</p>
              ) : null}
            </dl>
          ) : null}
          {state.kind === "vessel" ? (
            <dl className="kerbin-map-marker-modal-dl">
              <div title={CALLSIGN_DISPLAY_HELP}>
                <dt>Callsign</dt>
                <dd>{state.t.callsign?.trim() ? state.t.callsign : "—"}</dd>
              </div>
              <div><dt>Ship</dt><dd>{state.t.craftName ?? "—"}</dd></div>
              <div><dt>Pilot</dt><dd>{state.t.pilotName ?? "—"}</dd></div>
              <div><dt>Type</dt><dd>{state.t.craftType ?? "—"}</dd></div>
              <div>
                <dt>Body / situation</dt>
                <dd>
                  {state.t.bodyName ?? "—"} · {state.t.situation ?? "—"}
                </dd>
              </div>
              <BodyContextRow bodyName={state.t.bodyName} catalog={catalog} />
              <WorldBadgeRow
                viewerWorld={viewerWorld}
                status={describeSubjectWorld(state.t.bodyName, viewerWorld, catalog)}
                subjectBodyDisplay={state.t.bodyName ?? "this body"}
              />
              <div>
                <dt>Biome</dt>
                <dd>{state.t.biome && state.t.biome.length > 0 ? state.t.biome : "—"}</dd>
              </div>
              <div>
                <dt>Lat / lon</dt>
                <dd>
                  {formatNum(state.t.lat, 4)}° / {formatNum(state.t.lon, 4)}°
                </dd>
              </div>
              <div>
                <dt>Radar / ASL</dt>
                <dd>
                  {formatNum(state.t.radarAlt, 0)} m / {formatNum(state.t.aslAlt, 0)} m
                </dd>
              </div>
              <div>
                <dt>Heading / AoA / spd</dt>
                <dd>
                  {formatNum(state.t.heading, 1)}° ·{" "}
                  {state.t.aoa != null ? `${state.t.aoa.toFixed(1)}°` : "—"} ·{" "}
                  {state.t.surfaceSpeed != null ? `${state.t.surfaceSpeed.toFixed(1)} m/s` : "—"}
                </dd>
              </div>
              <div>
                <dt>Mass wet / dry</dt>
                <dd>
                  {formatMassTons(state.t.wetMass)} / {formatMassTons(state.t.dryMass)}
                </dd>
              </div>
              <div>
                <dt>Crew</dt>
                <dd>
                  {formatCrew(state.t)}
                  {/* Phase 4: per-kerbal stats with optional Kerbalism dose. */}
                  {state.t.crewStats && state.t.crewStats.length > 0 ? (
                    <ul className="kerbin-map-marker-crew kerbin-map-marker-crewstats">
                      {state.t.crewStats.map((c, i) => {
                        const dose = state.t.kerbalism?.crew?.find((k) => k.name === c.name)?.doseRad;
                        return (
                          <li key={`${c.name}-${i}`}>
                            <span
                              className={
                                "kerbin-map-marker-crew-name" +
                                (c.isVeteran ? " is-veteran" : "") +
                                (c.isBadass ? " is-badass" : "")
                              }
                            >
                              {c.name}
                            </span>
                            {" · "}
                            {c.trait || c.type} L{c.experienceLevel}
                            {dose != null ? (
                              <>
                                {" · "}
                                {formatRadiation(dose)}
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : state.t.crewNames && state.t.crewNames.length > 0 ? (
                    <div className="kerbin-map-marker-crew">{state.t.crewNames.join(", ")}</div>
                  ) : null}
                </dd>
              </div>
              {state.t.radiationAvailable ? (
                <div>
                  <dt>Radiation</dt>
                  <dd>{formatRadiation(state.t.radiation)}</dd>
                </div>
              ) : null}
              {/*
                Kerbalism Phase 4 (KERBALISM_TELEMETRY_PLAN.md, brought forward
                onto the Tower Desk + marker modal): one row per life-support
                resource the vessel carries, plus a storm warning when one is
                inbound. Stock saves with no Kerbalism see no rows.
              */}
              {state.t.kerbalism?.lifeSupport
                ? Object.entries(state.t.kerbalism.lifeSupport).map(([key, ls]) => (
                    <div key={`mm-ls-${key}`}>
                      <dt>{KERBALISM_LS_LABEL[key] ?? key}</dt>
                      <dd>
                        {formatKerbinDays(ls.daysRemaining, ls.secondsRemaining)}
                        {ls.max > 0 ? (
                          <>
                            {" · "}
                            {ls.amount.toFixed(1)} / {ls.max.toFixed(1)}
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ))
                : null}
              {state.t.kerbalism?.storm?.incoming ? (
                <div>
                  <dt>Storm</dt>
                  <dd>
                    INCOMING
                    {state.t.kerbalism.storm.durationSec != null ? (
                      <>
                        {" · "}
                        {formatDuration(state.t.kerbalism.storm.durationSec)} expected
                      </>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Comms</dt>
                <dd>
                  <span className={`tower-comms-chip tower-comms-chip-${commsStatus(state.t)}`}>
                    {commsStatusLabel(commsStatus(state.t), state.t.commSignal)}
                  </span>
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── aerodrome vector detail modal ─────────────────────────────────────────

function AerodromeVectorModal({
  aerodrome,
  onClose
}: {
  aerodrome: KerbinAerodrome;
  onClose: () => void;
}): JSX.Element {
  const titleId = "aerodrome-vector-modal-title";
  const freqs = KERBIN_AERODROME_FREQUENCIES.find((f) => f.aerodrome === aerodrome.id);

  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rwy09 = aerodrome.runways.find((r) => r.designator === "09");
  const rwy27 = aerodrome.runways.find((r) => r.designator === "27");

  return (
    <div
      className="kerbin-map-marker-modal-root aerodrome-chart-modal-root"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="kerbin-map-marker-modal aerodrome-chart-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kerbin-map-marker-modal-head">
          <h3 id={titleId} className="kerbin-map-marker-modal-title">
            {aerodrome.id} · {aerodrome.name}
          </h3>
          <button
            type="button"
            className="kerbin-map-marker-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="aerodrome-chart-modal-body">
          <p style={{ marginTop: 0, opacity: 0.9 }}>
            Tower gameplay data (MHz). Runway geometry matches the stock map projection.
          </p>
          {freqs ? (
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.35rem 1rem",
                margin: "0.75rem 0"
              }}
            >
              <dt>APP</dt>
              <dd style={{ margin: 0 }}>{freqs.approachMHz.toFixed(1)} MHz</dd>
              <dt>TWR</dt>
              <dd style={{ margin: 0 }}>{freqs.towerMHz.toFixed(1)} MHz</dd>
              <dt>GND</dt>
              <dd style={{ margin: 0 }}>{freqs.groundMHz.toFixed(1)} MHz</dd>
              <dt>ATIS</dt>
              <dd style={{ margin: 0 }}>{freqs.atisMHz.toFixed(1)} MHz</dd>
            </dl>
          ) : null}
          <p style={{ margin: "0.5rem 0 0.25rem", fontWeight: 600 }}>Runways</p>
          <p style={{ margin: "0 0 0.5rem", opacity: 0.85 }}>{aerodrome.runwaySpec}</p>
          {rwy09 && rwy27 ? (
            <svg
              viewBox="0 0 200 80"
              width="100%"
              style={{ maxHeight: 120, background: "rgba(15,23,42,0.35)", borderRadius: 6 }}
              aria-hidden
            >
              <line
                x1="20"
                y1="40"
                x2="180"
                y2="40"
                stroke="#f8fafc"
                strokeWidth="8"
                strokeLinecap="square"
              />
              <text x="20" y="28" fill="#94a3b8" fontSize="10">
                {rwy09.designator}
              </text>
              <text x="180" y="28" fill="#94a3b8" fontSize="10" textAnchor="end">
                {rwy27.designator}
              </text>
            </svg>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── main component ────────────────────────────────────────────────────────────────────────

/** Read-only pins (e.g. Dragon Radar balls) drawn like room waypoints; no server round-trip. */
export type KerbinReadOnlyMapPin = {
  id: string;
  lat: number;
  lon: number;
  /** When set, pin is only drawn while the operator is viewing this body in the map dropdown. */
  bodyName?: string;
  label: string;
  color?: string;
};

export type KerbinTowerMapProps = {
  /** Active session id (drives the live world-maps fetch). */
  sessionId: string;
  /** Live telemetry of the focused vessel (drives the vessel marker, the click-pick on the marker, and the marker modal). */
  telemetry: Telemetry | null;
  /**
   * All aircraft to draw when tower guidance is on (focused session plus `/v1/tower/active-aircraft`).
   * When omitted, the map falls back to `telemetry` only.
   */
  towerAircraft?: TowerAircraftTrack[] | null;
  /** Live world inventory POSTed by the KSP plugin. Drives navaids, launch sites, home base, distance scale. */
  worldInventory: WorldInventory | null;
  /** System catalog for the player's planet pack. Used by the marker modal's body-context row. */
  systemCatalog: SystemCatalog | null;
  /** Stable per-instance key for `localStorage` persistence (basemap layer / map body / height). Pass `undefined` to skip persistence. */
  persistKey?: string;
  /**
   * Vessel counts keyed by body name. Used by the in-toolbar `MapBodyDropdown` to badge bodies
   * with the number of vessels currently on them. Optional — wall slots don't aggregate counts.
   */
  vesselCounts?: Map<string, number>;
  /**
   * Optional callback fired when the operator picks a body in the in-toolbar `MapBodyDropdown`.
   * The desk uses this to swap from the home-body view to the per-body `BodyMap`. Wall slots can
   * omit it; the dropdown then only updates the basemap-body override locally.
   */
  onPickFocus?: (bodyName: string | null) => void;
  /** Tower wall body-map: stretch plate to slot (CSS `.kerbin-map-shell--wall-fill`). */
  wallSlot?: boolean;
  /** Hide tower aircraft + self marker (wall Dragon Radar: terrain + custom pins only). */
  suppressAircraftOverlay?: boolean;
  /** Hide room-shared waypoint pins (Dragon Radar wall should not duplicate waypoint clutter). */
  suppressSharedWaypointPins?: boolean;
  /** Extra read-only pins (filtered by the map body dropdown like shared waypoints). */
  readOnlyOverlayPins?: ReadonlyArray<KerbinReadOnlyMapPin> | null;
};

export function KerbinTowerMap({
  sessionId,
  telemetry,
  towerAircraft,
  worldInventory,
  systemCatalog,
  persistKey,
  vesselCounts,
  onPickFocus,
  wallSlot = false,
  suppressAircraftOverlay = false,
  suppressSharedWaypointPins = false,
  readOnlyOverlayPins = null
}: KerbinTowerMapProps): JSX.Element {
  // Derived from props
  const effectiveNavaids = useMemo<readonly KerbinNavAid[]>(
    () => (worldInventory ? navaidsForHomeBody(worldInventory) : KERBIN_NAVAIDS),
    [worldInventory]
  );
  const effectiveLaunchSites = useMemo<readonly KerbinLaunchSite[]>(
    () => (worldInventory ? launchSitesForHomeBody(worldInventory) : KERBIN_LAUNCH_SITES),
    [worldInventory]
  );
  const homeBodyRadiusM = worldInventory?.home.radiusM ?? KERBIN_RADIUS_M;
  const homeBodyRadiusKm = homeBodyRadiusM / 1000;
  const ilsMarkers = useMemo(() => buildKerbinIlsMarkers(homeBodyRadiusM), [homeBodyRadiusM]);
  const homeBodyName = worldInventory?.home.name ?? "Kerbin";
  const { homeBaseLat, homeBaseLon } = useMemo<{ homeBaseLat: number; homeBaseLon: number }>(() => {
    const center =
      effectiveNavaids.find((n) => n.id === "KST") ??
      effectiveNavaids.find((n) => n.name.toUpperCase() === "CENTER");
    if (center) return { homeBaseLat: center.lat, homeBaseLon: center.lon };
    const firstSite = effectiveLaunchSites[0];
    if (firstSite) return { homeBaseLat: firstSite.lat, homeBaseLon: firstSite.lon };
    return { homeBaseLat: KSC_LAT, homeBaseLon: KSC_LON };
  }, [effectiveNavaids, effectiveLaunchSites]);

  // Refs
  const mapAspectRef = useRef<HTMLDivElement | null>(null);
  const mapZoomportRef = useRef<HTMLDivElement | null>(null);
  const mapOverlaySvgRef = useRef<SVGSVGElement | null>(null);
  // Wraps the bundled vector-terrain SVG injected via dangerouslySetInnerHTML.
  // We need a handle to walk its DOM and counter-scale every internal stroke
  // when the outer .kerbin-map-zoom-stack CSS scale changes — see the
  // useEffect block keyed on [terrainSvgHtml, mapZoom] below.
  const terrainHostRef = useRef<HTMLDivElement | null>(null);
  /** Revoked whenever a new basemap load starts or the effect cleans up (raster blob URLs). */
  const rasterBlobRevokeRef = useRef<string | null>(null);
  const mapPanDragRef = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    pointerId: number;
  } | null>(null);
  const mapPanRef = useRef({ x: 0, y: 0 });
  const mapZoomRef = useRef(1);
  const lastHeadingRef = useRef<number | null>(null);

  // State
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [basemap, setBasemap] = useState<KerbinBasemapManifest | null>(null);
  const [terrainSvgHtml, setTerrainSvgHtml] = useState<string | null>(null);
  const [rasterUrl, setRasterUrl] = useState<string | null>(null);
  const [rasterLoaded, setRasterLoaded] = useState(false);
  const [basemapTerrainErr, setBasemapTerrainErr] = useState<string | null>(null);
  const [mapShowVor, setMapShowVor] = useState(true);
  const [mapShowIls, setMapShowIls] = useState(true);
  const [mapShowNdb, setMapShowNdb] = useState(true);
  const [mapShowKsc, setMapShowKsc] = useState(true);
  const [mapShowSites, setMapShowSites] = useState(true);
  // Anomalies (Mun arches, KSC2, monoliths, the Duna face, …) — populated from the live world-maps
  // bake's `features` array. Default-on so first-timers see the easter eggs without hunting.
  const [mapShowAnomalies, setMapShowAnomalies] = useState(true);
  // Reception-range rings (`KERBIN_NAVAID_CLASS_RANGES` + `approxNavaidRangeKm`). Off by
  // default because every visible beacon adds an ellipse, and the rings make
  // the map noisy when you're just trying to pick a marker. Altitude default
  // 5 000 m ASL matches the published reference column in `kerbinAeroCharts.ts`.
  const [mapShowRanges, setMapShowRanges] = useState(false);
  const [mapRangeAltitudeM, setMapRangeAltitudeM] = useState(5000);
  // KKSC + KAFD ILS approach geometry, drawn as native SVG (runway boxes,
  // extended centerlines, OM/MM/IM markers, missed-approach turn) so it
  // scales/zooms with the map exactly like every other vector layer instead
  // of being a fuzzy raster hypsometry layer. Off by default because the
  // approach geometry is only legible when zoomed in past Kerbin scale.
  const [mapShowApproaches, setMapShowApproaches] = useState(false);
  /** KSC distance rings, approach cones, and multi-aircraft label blocks for tower control. */
  const [mapShowTowerGuidance, setMapShowTowerGuidance] = useState(() => readTowerGuidancePref(persistKey));
  // World maps manifest (live in-game PQS bake) is fetched via TanStack Query
  // so other panels that need it (e.g. tower wall) share one HTTP call. We
  // still default to `null` (= "use bundled schematic basemap") on 404 / before
  // the plugin has reached the Space Center.
  const trimmedSessionId = sessionId.trim();
  const worldMapsQuery = useApiQuery<WorldMapsManifest | null>({
    queryKey: queryKeys.world.maps(trimmedSessionId || "__none__"),
    queryFn: () => fetchWorldMapsManifest(trimmedSessionId),
    enabled: !!trimmedSessionId,
    refetchInterval: trimmedSessionId ? 60_000 : false,
    staleTime: 30_000,
    placeholderData: (prev) => prev
  });
  const worldMaps = worldMapsQuery.data ?? null;

  // Session detail subscription — read-side ONLY, used to surface room-shared waypoints (the
  // tower controller / spectators dropping pins for the pilot to track). The parent desk already
  // polls this endpoint every 1 s; sharing the same `queryKeys.session.detail` key means
  // TanStack dedupes both subscribers onto a single HTTP call. We DON'T want this to drive
  // anything else on the map (telemetry / health flow through props from the parent), so we just
  // pluck `sharedWaypoints` and ignore the rest.
  const sessionDetailQuery = useApiQuery<SessionDetailLite>({
    queryKey: queryKeys.session.detail(sessionId),
    // Always pass a path; `enabled` gates whether the query actually fires. The empty-sessionId
    // case never reaches the network because `useQuery` short-circuits on `enabled: false`.
    path: `/v1/session/${encodeURIComponent(sessionId.trim() || "no-session")}`,
    enabled: !!sessionId.trim(),
    refetchInterval: sessionId.trim() ? 1_000 : false,
    placeholderData: (prev) => prev
  });
  const sharedWaypoints: ReadonlyArray<SharedMapWaypoint> = useMemo(
    () => sessionDetailQuery.data?.session?.sharedWaypoints ?? [],
    [sessionDetailQuery.data?.session?.sharedWaypoints]
  );

  const queryClient = useQueryClient();
  // Add waypoint mutation. We optimistically clear the pick pill on success so the operator gets
  // immediate feedback instead of waiting for the next 1 s poll cycle to render the new pin.
  const addWaypointMutation = useApiMutation<
    { ok: true; waypoint: SharedMapWaypoint; sharedWaypoints: SharedMapWaypoint[] },
    { lat: number; lon: number; bodyName: string; label?: string; color?: string }
  >({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId.trim())}/waypoints`, {
        method: "POST",
        body: JSON.stringify(vars)
      }),
    onSuccess: (data) => {
      // Patch the cached session detail so the marker shows up THIS frame, before the next poll.
      queryClient.setQueryData<SessionDetailLite | undefined>(
        queryKeys.session.detail(sessionId),
        (prev) => {
          if (!prev?.session) return prev;
          return { ...prev, session: { ...prev.session, sharedWaypoints: data.sharedWaypoints } };
        }
      );
    }
  });
  const removeWaypointMutation = useApiMutation<
    { ok: true; sharedWaypoints: SharedMapWaypoint[] },
    { waypointId: string }
  >({
    mutationFn: (vars) =>
      apiCall(
        `/v1/session/${encodeURIComponent(sessionId.trim())}/waypoints/${encodeURIComponent(vars.waypointId)}`,
        { method: "DELETE" }
      ),
    onSuccess: (data) => {
      queryClient.setQueryData<SessionDetailLite | undefined>(
        queryKeys.session.detail(sessionId),
        (prev) => {
          if (!prev?.session) return prev;
          return { ...prev, session: { ...prev.session, sharedWaypoints: data.sharedWaypoints } };
        }
      );
    }
  });
  const [basemapLayerPref, setBasemapLayerPrefState] = useState<BasemapLayerPref>(() =>
    readBasemapLayerPref(persistKey)
  );
  const setBasemapLayerPref = useCallback(
    (v: BasemapLayerPref) => {
      setBasemapLayerPrefState(v);
      writeBasemapLayerPref(persistKey, v);
    },
    [persistKey]
  );
  const [mapBodyPref, setMapBodyPrefState] = useState<MapBodyPref>(() => readMapBodyPref(persistKey));
  const setMapBodyPref = useCallback(
    (v: MapBodyPref) => {
      setMapBodyPrefState(v);
      writeMapBodyPref(persistKey, v);
    },
    [persistKey]
  );

  useEffect(() => {
    writeTowerGuidancePref(persistKey, mapShowTowerGuidance);
  }, [persistKey, mapShowTowerGuidance]);

  // Cross-pack pref leak guard: if the user picked "Earth" while testing RSS in a previous
  // session and now booted into stock Kerbin, the persisted "Earth" pref would survive and the
  // map would render the (wrong) Earth basemap on top of Kerbin telemetry. We resolve the live
  // world's system catalog and reset to "auto" if the persisted body isn't a real body in this
  // pack. Mun, Eve, Duna etc. all stay sticky in stock; Mars stays sticky in RSS; only the
  // mismatched cross-pack value gets cleared. Runs once per worldId change, lazily.
  useEffect(() => {
    if (mapBodyPref === "auto") return;
    const liveWorldId = worldInventory?.worldId ?? null;
    if (!liveWorldId) return;
    let cancelled = false;
    void loadSystemCatalog(liveWorldId).then((cat) => {
      if (cancelled || !cat) return;
      const want = mapBodyPref.toLowerCase();
      const found = cat.bodies.some((b) => b.name.toLowerCase() === want);
      if (!found) {
        setMapBodyPref("auto");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [worldInventory?.worldId, mapBodyPref, setMapBodyPref]);
  // The bundled `basemap.json` lists every body it has artwork for under `byBody`. The toolbar's
  // `MapBodyDropdown` no longer reads from this list (it pulls bodies from the static system
  // catalog instead), so we only keep the setter to avoid touching the manifest-loading effect.
  const [, setAvailableBasemapBodies] = useState<readonly string[]>([]);
  const [mapClickPick, setMapClickPick] = useState<{ lat: number; lon: number } | null>(null);
  // Async biome/slope/elevation lookup attached to the current click pick. Cleared when the pick
  // moves; an in-flight sample whose key no longer matches the active pick is dropped on receipt
  // (see effect below) so we don't render a stale label after a quick second click.
  const [mapClickPickInfo, setMapClickPickInfo] = useState<{
    /** Keyed `${lat.toFixed(5)},${lon.toFixed(5)}` to discard stale results. */
    key: string;
    biome: string | null;
    slope: string | null;
    /** Source flag — "proxy" until live palettes ship; "live" once a future plugin update bakes them. */
    biomeSource: "proxy" | "live" | "unavailable";
    slopeSource: "proxy" | "live" | "unavailable";
  } | null>(null);
  const [mapMarkerModal, setMapMarkerModal] = useState<KerbinMapMarkerModalState | null>(null);
  // Vector aerodrome diagram (PLT modal) for KKSC/KAFD. Stored as the aerodrome id so a later catalog
  // edit (renumbered runways etc.) doesn't strand a stale closure here.
  const [aerodromeChartId, setAerodromeChartId] = useState<KerbinAerodrome["id"] | null>(null);
  const [mapFrameTicks, setMapFrameTicks] = useState<MapFrameTicks | null>(null);

  const mapOverlayReady = useMemo((): boolean => {
    if (!basemap) return false;
    if (basemap.kind === "svg") return terrainSvgHtml != null && terrainSvgHtml.length > 0;
    return rasterUrl != null;
  }, [basemap, terrainSvgHtml, rasterUrl]);

  const vesselHeadingDeg = useMemo<number | null>(() => {
    const tHeading =
      typeof telemetry?.heading === "number" && Number.isFinite(telemetry.heading)
        ? telemetry.heading
        : null;
    if (tHeading != null) {
      lastHeadingRef.current = tHeading;
      return tHeading;
    }
    return lastHeadingRef.current;
  }, [telemetry?.heading]);

  const hasCoords = telemetry?.lat != null && telemetry?.lon != null;
  const onHomeBody = telemetry?.bodyName?.toLowerCase() === homeBodyName.toLowerCase();

  // The body whose map the user is currently looking at. `mapBodyPref` of "auto" means "follow
  // the live home body". Used to gate per-body rendering decisions: which basemap to fetch,
  // whether the live PNG bake is relevant (only when its body matches), and which markers to
  // draw (KSC/navaids/launch-sites only make sense when viewing their owning body).
  const effectiveMapBodyName = useMemo<string>(
    () => (mapBodyPref === "auto" ? homeBodyName : mapBodyPref),
    [mapBodyPref, homeBodyName]
  );
  const isViewingHomeBody = effectiveMapBodyName.toLowerCase() === homeBodyName.toLowerCase();
  const liveBakeMatchesView =
    worldMaps != null && worldMaps.body.name.toLowerCase() === effectiveMapBodyName.toLowerCase();

  const resolvedTowerAircraft = useMemo((): TowerAircraftTrack[] => {
    if (suppressAircraftOverlay) return [];
    if (towerAircraft && towerAircraft.length > 0) return towerAircraft;
    if (telemetry?.lat != null && telemetry?.lon != null) {
      return [
        {
          id: sessionId.trim() || "self",
          label: aircraftPrimaryLabel(telemetry),
          telemetry,
          isSelf: true
        }
      ];
    }
    return [];
  }, [suppressAircraftOverlay, towerAircraft, telemetry, sessionId]);

  const vesselPickTargets = useMemo((): readonly Telemetry[] => {
    const viewLc = effectiveMapBodyName.toLowerCase();
    const onViewBody = (t: Telemetry): boolean =>
      t.lat != null &&
      t.lon != null &&
      (t.bodyName ?? "").toLowerCase() === viewLc;
    if (mapShowTowerGuidance) {
      return resolvedTowerAircraft.map((tr) => tr.telemetry).filter(onViewBody);
    }
    return telemetry && onViewBody(telemetry) ? [telemetry] : [];
  }, [mapShowTowerGuidance, resolvedTowerAircraft, telemetry, effectiveMapBodyName]);

  // Sync zoom/pan refs
  useEffect(() => {
    mapPanRef.current = mapPan;
  }, [mapPan]);
  useEffect(() => {
    mapZoomRef.current = mapZoom;
  }, [mapZoom]);

  const applyZoomKeepClientPoint = useCallback(
    (clientX: number, clientY: number, z1: number) => {
      const z0 = mapZoomRef.current;
      if (z1 === z0) return;
      const svg = mapOverlaySvgRef.current;
      if (!svg) {
        const el = mapZoomportRef.current;
        if (!el) return;
        const zr = el.getBoundingClientRect();
        const ax = clientX - zr.left;
        const ay = clientY - zr.top;
        flushSync(() => {
          setMapZoom(z1);
          mapZoomRef.current = z1;
          setMapPan((p0) => {
            const n = panLinearZoomAnchor(p0, z0, z1, ax, ay);
            mapPanRef.current = n;
            return n;
          });
        });
        return;
      }
      const ctm0 = svg.getScreenCTM();
      if (!ctm0) {
        const el = mapZoomportRef.current;
        if (!el) return;
        const zr = el.getBoundingClientRect();
        const ax = clientX - zr.left;
        const ay = clientY - zr.top;
        flushSync(() => {
          setMapZoom(z1);
          mapZoomRef.current = z1;
          setMapPan((p0) => {
            const n = panLinearZoomAnchor(p0, z0, z1, ax, ay);
            mapPanRef.current = n;
            return n;
          });
        });
        return;
      }
      let inv: DOMMatrix;
      try {
        inv = ctm0.inverse();
      } catch {
        return;
      }
      const fixed = new DOMPoint(clientX, clientY).matrixTransform(inv);
      flushSync(() => {
        setMapZoom(z1);
        mapZoomRef.current = z1;
      });
      const ctm1 = svg.getScreenCTM();
      if (!ctm1) return;
      let newScr: DOMPoint;
      try {
        newScr = fixed.matrixTransform(ctm1);
      } catch {
        return;
      }
      const dx = clientX - newScr.x;
      const dy = clientY - newScr.y;
      flushSync(() => {
        setMapPan((p) => {
          const n = { x: p.x + dx, y: p.y + dy };
          mapPanRef.current = n;
          return n;
        });
      });
    },
    []
  );

  // Rim labels recompute on zoom/pan/resize
  useLayoutEffect(() => {
    let raf = 0;
    const recompute = (): void => {
      const svg = mapOverlaySvgRef.current;
      const zp = mapZoomportRef.current;
      if (!svg || !zp || !mapOverlayReady) {
        setMapFrameTicks(null);
        return;
      }
      const zr = zp.getBoundingClientRect();
      if (zr.width < 8 || zr.height < 8) {
        setMapFrameTicks(null);
        return;
      }
      setMapFrameTicks(buildViewportEdgeTicks(svg, zr, MAP_FRAME_EDGE_SEGMENTS));
    };
    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    schedule();
    const zp = mapZoomportRef.current;
    const aspect = mapAspectRef.current;
    const ro = new ResizeObserver(() => {
      schedule();
    });
    if (zp) ro.observe(zp);
    if (aspect) ro.observe(aspect);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [mapZoom, mapPan, mapOverlayReady]);

  // Basemap fetch (live PQS bake → bundled per-body manifest → fallback schematic)
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void (async (): Promise<void> => {
      const fallbackManifest: KerbinBasemapManifest = {
        projection: "equirectangular",
        viewBoxWidth: KERBIN_MAP_VB_W,
        viewBoxHeight: KERBIN_MAP_VB_H,
        kind: "svg",
        uri: "maps/kerbin-base-schematic.svg",
        assetVersion: 2,
        attribution: "Original schematic plate bundled with KSCTowerNetwork (no third-party art).",
        chartBlurb: DEFAULT_CHART_BLURB,
        hypsometryKey: "generic"
      };
      try {
        if (rasterBlobRevokeRef.current) {
          URL.revokeObjectURL(rasterBlobRevokeRef.current);
          rasterBlobRevokeRef.current = null;
        }

        let manifest: KerbinBasemapManifest | null = null;

        // Only consult the live PNG bake when (a) the user actually wants a data layer (not the
        // schematic), AND (b) the bake we have is for the body the user is currently viewing.
        // Without the body-match gate, picking RSS Earth from the dropdown while a stock-Kerbin
        // bake was in flight would render Kerbin's PNG under the Earth label.
        if (basemapLayerPref !== "schematic" && worldMaps && liveBakeMatchesView) {
          // Strict layer match — no fallback to "alt". The radio buttons promise distinct data
          // (alt / biome / slope); silently substituting alt when biome/slope wasn't shipped
          // makes all three radios show the same image and feels broken. If the requested layer
          // isn't in this bake, we fall through and let the static basemap.json supply its own
          // per-layer SVG (which is exactly what the offline catalog is for).
          const layer = worldMaps.layers.find((l) => l.id === basemapLayerPref);
          if (layer) {
            // v3 plugin extracts textures directly from KSP (`body.scaledBody._MainTex` and
            // `body.BiomeMap`) and POSTs PNG bytes — render those as raster <img>. Older
            // SVG-based layers (and any future quantitative SVG slope) take the inline-svg path.
            const layerKind: KerbinBasemapKind = layer.contentType === "image/png" ? "raster" : "svg";
            manifest = {
              projection: "equirectangular",
              viewBoxWidth: layer.viewBoxW,
              viewBoxHeight: layer.viewBoxH,
              kind: layerKind,
              uri: layer.url,
              assetVersion: 0,
              attribution:
                layer.contentType === "image/png"
                  ? `In-game texture extract of ${worldMaps.body.displayName} (${layer.label}).`
                  : `In-game PQS bake of ${worldMaps.body.displayName} (${layer.label}).`,
              chartBlurb: DEFAULT_CHART_BLURB,
              hypsometryKey: layer.hypsometryKey === "jebbesen" ? "jebbesen" : "generic"
            };
          }
        }

        if (!manifest) {
          try {
            const rm = await fetch(`${BASEMAP_JSON}?t=${Date.now()}`, {
              signal: ac.signal,
              credentials: "include"
            });
            if (rm.ok) manifest = parseKerbinBasemapManifest(await rm.json());
          } catch {
            /* use fallback */
          }
        }
        if (!manifest) manifest = fallbackManifest;

        if (!cancelled && manifest.byBody) {
          const bodies = Object.keys(manifest.byBody);
          setAvailableBasemapBodies((prev) => {
            if (prev.length === bodies.length && prev.every((b, i) => b === bodies[i])) return prev;
            return bodies;
          });
        }

        const basemapBody = mapBodyPref === "auto" ? homeBodyName : mapBodyPref;
        manifest = resolveBasemapForBody(manifest, basemapBody);
        if (basemapLayerPref !== "schematic") {
          manifest = applyBasemapLayer(manifest, basemapLayerPref);
        }
        if (
          !manifest.uri.startsWith("/") &&
          (manifest.viewBoxWidth !== KERBIN_MAP_VB_W || manifest.viewBoxHeight !== KERBIN_MAP_VB_H)
        ) {
          console.warn(
            "basemap.json viewBox does not match KERBIN_MAP_VB_W/H in KerbinTowerMap.tsx — graticule and picks may drift."
          );
        }
        if (cancelled) return;
        const isAbsoluteUri = manifest.uri.startsWith("/");
        const v = manifest.assetVersion ?? 1;
        const assetPath = manifest.uri.replace(/^\//, "");
        const assetUrl = isAbsoluteUri ? manifest.uri : `${MAP_ASSET_BASE}${assetPath}?v=${v}`;

        if (manifest.kind === "raster") {
          if (cancelled) return;
          setTerrainSvgHtml(null);
          setRasterLoaded(false);
          if (assetUrl.startsWith("/v1/")) {
            const resp = await fetchBasemapHttp(assetUrl, ac.signal);
            const blob = await resp.blob();
            if (cancelled) return;
            const blobUrl = URL.createObjectURL(blob);
            rasterBlobRevokeRef.current = blobUrl;
            setBasemap(manifest);
            setRasterUrl(blobUrl);
          } else {
            setBasemap(manifest);
            setRasterUrl(assetUrl);
          }
          setBasemapTerrainErr(null);
          return;
        }

        const r = await fetchBasemapHttp(assetUrl, ac.signal);
        const text = await r.text();
        if (cancelled) return;
        setBasemap(manifest);
        setTerrainSvgHtml(patchKerbinTerrainSvgRoot(text, wallSlot ? "none" : KERBIN_MAP_PRESERVE_ASPECT));
        setRasterUrl(null);
        setRasterLoaded(false);
        setBasemapTerrainErr(null);
      } catch (e: unknown) {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        if (!cancelled) {
          if (rasterBlobRevokeRef.current) {
            URL.revokeObjectURL(rasterBlobRevokeRef.current);
            rasterBlobRevokeRef.current = null;
          }
          setBasemap(null);
          setTerrainSvgHtml(null);
          setRasterUrl(null);
          setBasemapTerrainErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      if (rasterBlobRevokeRef.current) {
        URL.revokeObjectURL(rasterBlobRevokeRef.current);
        rasterBlobRevokeRef.current = null;
      }
    };
  }, [worldMaps, basemapLayerPref, homeBodyName, mapBodyPref, liveBakeMatchesView, wallSlot]);

  // World-maps manifest is now sourced from the TanStack query above
  // (`worldMapsQuery`) — replaces the old 60s setInterval poller.

  // Counter-scale stroke widths inside the bundled vector terrain SVG.
  //
  // Why: the SVG is injected via dangerouslySetInnerHTML, so its strokes live
  // in *its* coordinate system (paths declared with stroke-width=".216" and
  // friends). The outer .kerbin-map-zoom-stack wrapper applies a CSS
  // `transform: scale(mapZoom)` to its container — and CSS transforms
  // applied OUTSIDE an <svg> still scale the rendered stroke pixels.
  // vector-effect="non-scaling-stroke" only neutralizes transforms INSIDE the
  // svg, so it does not help here. Without this effect the equator and prime
  // meridian (drawn as ~0.2-unit pen strokes) bloom to ~17 px wide bars at
  // 80x and ~50 px wide bars at runway zoom (~250x zoom),
  // covering most of the map — exactly the "huge black bands" reported.
  //
  // Strategy: on first sight of a freshly-loaded SVG, snapshot every
  // stroke-width attribute as a data-base-stroke-width sidecar so we never
  // lose the original. Then, every time mapZoom changes, restripe each
  // element's stroke-width to base/mapZoom. Also pin a counter-scaled
  // stroke-width on the root <svg> so any element relying on the SVG default
  // (stroke-width: 1) inherits a sensible scaled value.
  useEffect(() => {
    const host = terrainHostRef.current;
    if (!host || !terrainSvgHtml) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const safeZoom = mapZoom > 0 ? mapZoom : 1;
    const ensureBaseAttr = (el: Element, fallback: string | null): void => {
      if (el.hasAttribute("data-base-stroke-width")) return;
      const w = el.getAttribute("stroke-width") ?? fallback;
      if (w != null) el.setAttribute("data-base-stroke-width", w);
    };
    ensureBaseAttr(svg, "1");
    svg.querySelectorAll("[stroke-width]").forEach((el) => ensureBaseAttr(el, null));
    const apply = (el: Element): void => {
      const base = el.getAttribute("data-base-stroke-width");
      if (base == null) return;
      const n = parseFloat(base);
      if (!Number.isFinite(n)) return;
      el.setAttribute("stroke-width", String(n / safeZoom));
    };
    apply(svg);
    svg.querySelectorAll("[data-base-stroke-width]").forEach(apply);
  }, [terrainSvgHtml, mapZoom]);

  // Wheel zoom
  useEffect(() => {
    const el = mapZoomportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const z0 = mapZoomRef.current;
      const z1 = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z0 * factor));
      applyZoomKeepClientPoint(e.clientX, e.clientY, z1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoomKeepClientPoint]);

  // ─── click-pick enrichment (biome / slope at the picked lat-lon) ────────────────────────
  //
  // Fires whenever the click pick or the current body changes. Resolves biome + slope by
  // sampling the basemap.json layer SVGs (Kerbin / Earth) as RGB proxies.
  useEffect(() => {
    if (!mapClickPick) {
      setMapClickPickInfo(null);
      return;
    }
    const key = `${mapClickPick.lat.toFixed(5)},${mapClickPick.lon.toFixed(5)}`;
    // Render placeholder ("…") while we sample so the pill doesn't flash empty content.
    setMapClickPickInfo({
      key,
      biome: null,
      slope: null,
      biomeSource: "proxy",
      slopeSource: "proxy"
    });

    const bodyLc = effectiveMapBodyName.toLowerCase();
    if (bodyLc !== "kerbin" && bodyLc !== "earth") {
      setMapClickPickInfo({
        key,
        biome: null,
        slope: null,
        biomeSource: "unavailable",
        slopeSource: "unavailable"
      });
      return;
    }

    const u = (normalizeLon(mapClickPick.lon) + 180) / 360;
    const v = (90 - mapClickPick.lat) / 180;
    const biomeUri =
      bodyLc === "earth"
        ? "maps/earth-topo5-biome-equirect.svg"
        : basemap?.layers?.biome?.uri ?? "maps/kerbin-base-schematic.svg";
    const slopeUri =
      bodyLc === "earth"
        ? "maps/earth-topo5-slope-equirect.svg"
        : basemap?.layers?.slope?.uri ?? "maps/kerbin-base-schematic.svg";
    const biomeUrl = `${MAP_ASSET_BASE}${biomeUri.replace(/^\//, "")}`;
    const slopeUrl = `${MAP_ASSET_BASE}${slopeUri.replace(/^\//, "")}`;

    let cancelled = false;
    void (async () => {
      const [biomeS, slopeS] = await Promise.all([
        loadRgbSampler(biomeUrl),
        loadRgbSampler(slopeUrl)
      ]);
      if (cancelled) return;
      const biome = biomeS ? nearestBandLabel(biomeS(u, v), BIOME_PROXY_RGB) : null;
      const slope = slopeS ? nearestBandLabel(slopeS(u, v), SLOPE_PROXY_RGB) : null;
      setMapClickPickInfo((prev) =>
        prev?.key === key
          ? { key, biome, slope, biomeSource: "proxy", slopeSource: "proxy" }
          : prev
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [mapClickPick, effectiveMapBodyName, basemap]);

  // Click-pick + marker modal hit testing on pointerup
  useEffect(() => {
    const end = (e: PointerEvent): void => {
      const d = mapPanDragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
      mapPanDragRef.current = null;
      if (dist <= MAP_CLICK_PAN_THRESHOLD_PX) {
        const svg = mapOverlaySvgRef.current;
        if (svg && mapOverlayReady) {
          const hit = pickKerbinMapMarkerAtClient(svg, e.clientX, e.clientY, {
            mapShowVor,
            mapShowIls,
            mapShowNdb,
            mapShowKsc,
            mapShowSites,
            vesselTargets: vesselPickTargets,
            navaids: effectiveNavaids,
            launchSites: effectiveLaunchSites,
            kscLat: homeBaseLat,
            kscLon: homeBaseLon,
            homeBodyName
          });
          if (hit) {
            setMapMarkerModal(hit);
            setMapClickPick(null);
          } else {
            const g = clientToMapLatLon(svg, e.clientX, e.clientY);
            if (g) {
              setMapClickPick(g);
              setMapMarkerModal(null);
            }
          }
        }
      }
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [
    mapOverlayReady,
    mapShowVor,
    mapShowIls,
    mapShowNdb,
    mapShowKsc,
    mapShowSites,
    vesselPickTargets,
    effectiveNavaids,
    effectiveLaunchSites,
    homeBaseLat,
    homeBaseLon,
    homeBodyName,
    basemap
  ]);

  // Esc closes the marker modal
  useEffect(() => {
    if (!mapMarkerModal) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setMapMarkerModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapMarkerModal]);

  // Pan handlers + zoom toolbar helpers
  function onMapPointerDown(e: React.PointerEvent): void {
    if (e.button !== 0) return;
    const p = mapPanRef.current;
    mapPanDragRef.current = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, pointerId: e.pointerId };
  }
  function onMapPointerMove(e: React.PointerEvent): void {
    const d = mapPanDragRef.current;
    if (!d) return;
    setMapPan({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
  }
  const zoomBy = (factor: number): void => {
    const zp = mapZoomportRef.current;
    const zr = zp?.getBoundingClientRect();
    if (!zr) return;
    const cx = zr.left + zr.width / 2;
    const cy = zr.top + zr.height / 2;
    const z0 = mapZoomRef.current;
    const z1 = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z0 * factor));
    applyZoomKeepClientPoint(cx, cy, z1);
  };

  /**
   * Center the map on a lat/lon and snap zoom to the requested level. Used by the
   * "Sites" dropdown's per-site Go-to buttons so the operator can jump straight
   * from the toolbar to KSC, KAFD, Woomerang, etc. without panning by hand.
   *
   * The `.kerbin-map-zoom-stack` wrapper applies `translate(pan) scale(zoom)` with
   * `transform-origin: 0 0`. The SVG inside fills the zoomport (viewBox 0 0
   * KERBIN_MAP_VB_W KERBIN_MAP_VB_H), so a viewbox point (vbX, vbY) sits at
   * pixel `(pan.x + vbX * (zpW/VBW) * zoom, pan.y + vbY * (zpH/VBH) * zoom)`.
   * Solve for pan to put that point at the zoomport center.
   */
  const panToLatLon = useCallback((lat: number, lon: number, zoomTarget?: number): void => {
    const zp = mapZoomportRef.current;
    if (!zp) return;
    const zr = zp.getBoundingClientRect();
    if (zr.width < 8 || zr.height < 8) return;
    const z = Math.min(
      MAP_ZOOM_MAX,
      Math.max(MAP_ZOOM_MIN, zoomTarget ?? Math.max(mapZoomRef.current, 6))
    );
    const { x: vbX, y: vbY } = latLonToMapVB(lat, lon);
    const sx = zr.width / KERBIN_MAP_VB_W;
    const sy = zr.height / KERBIN_MAP_VB_H;
    const newPan = {
      x: zr.width / 2 - vbX * sx * z,
      y: zr.height / 2 - vbY * sy * z
    };
    flushSync(() => {
      setMapZoom(z);
      mapZoomRef.current = z;
      setMapPan(newPan);
      mapPanRef.current = newPan;
    });
  }, []);

  /** Whole-planet view with KSC at the zoomport center (not top-left). */
  function mapFit(): void {
    panToLatLon(homeBaseLat, homeBaseLon, MAP_ZOOM_MIN);
  }

  const autoCenteredHomeBodyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!mapOverlayReady || !isViewingHomeBody) return;
    if (autoCenteredHomeBodyRef.current === effectiveMapBodyName) return;
    const zp = mapZoomportRef.current;
    if (!zp) return;
    const zr = zp.getBoundingClientRect();
    if (zr.width < 8 || zr.height < 8) return;
    autoCenteredHomeBodyRef.current = effectiveMapBodyName;
    panToLatLon(homeBaseLat, homeBaseLon, 12);
  }, [
    mapOverlayReady,
    isViewingHomeBody,
    effectiveMapBodyName,
    homeBaseLat,
    homeBaseLon,
    panToLatLon
  ]);

  return (
    <>
      {mapMarkerModal ? (
        <KerbinMapMarkerModalView
          state={mapMarkerModal}
          onClose={() => setMapMarkerModal(null)}
          viewerWorld={worldInventory}
          catalog={systemCatalog}
        />
      ) : null}
      {aerodromeChartId ? (() => {
        const aero = KERBIN_AERODROMES.find((a) => a.id === aerodromeChartId);
        if (!aero) return null;
        return <AerodromeVectorModal aerodrome={aero} onClose={() => setAerodromeChartId(null)} />;
      })() : null}

      <div
        className={`kerbin-map-shell tower-map-shell${wallSlot ? " kerbin-map-shell--wall-fill" : ""}`}
      >
        <div className="kerbin-map-frame">
          <div
            ref={mapAspectRef}
            className="kerbin-map-aspect-wrap"
            onPointerDown={onMapPointerDown}
            onPointerMove={onMapPointerMove}
          >
            <div ref={mapZoomportRef} className="kerbin-map-zoomport">
              <div
                className="kerbin-map-zoom-stack"
                style={{ transform: `translate(${mapPan.x}px, ${mapPan.y}px) scale(${mapZoom})` }}
              >
                {basemapTerrainErr ? (
                  <div className="kerbin-map-terrain-placeholder" role="alert">
                    Map basemap failed to load ({basemapTerrainErr}).{" "}
                    {basemap?.uri?.startsWith("/") ? (
                      <>
                        Check that the KSP plugin published a world-map for this session
                        (<code>POST /v1/world-maps/{sessionId}</code>) and that the backend is
                        reachable.
                      </>
                    ) : (
                      <>
                        Check <code>public/maps/basemap.json</code> and the <code>uri</code> asset.
                      </>
                    )}
                  </div>
                ) : null}
                {!basemapTerrainErr && (!mapOverlayReady || (basemap?.kind === "raster" && !rasterLoaded)) ? (
                  <div className="kerbin-map-terrain-placeholder">Loading terrain…</div>
                ) : null}
                {basemap?.kind === "raster" && rasterUrl ? (
                  <img
                    key={rasterUrl}
                    src={rasterUrl}
                    alt=""
                    className="kerbin-map-raster kerbin-map-terrain-inline"
                    onLoad={() => setRasterLoaded(true)}
                    onError={() =>
                      setBasemapTerrainErr("Raster basemap failed to load (check uri in basemap.json)")
                    }
                  />
                ) : null}
                {terrainSvgHtml && basemap?.kind === "svg" ? (
                  <div
                    ref={terrainHostRef}
                    className="kerbin-map-raster kerbin-map-terrain-inline"
                    aria-label="Kerbin equirect terrain (vector SVG)"
                    dangerouslySetInnerHTML={{ __html: terrainSvgHtml }}
                  />
                ) : null}
                {mapOverlayReady ? (
                  <svg
                    ref={mapOverlaySvgRef}
                    className="kerbin-map-overlay-svg"
                    viewBox={`0 0 ${KERBIN_MAP_VB_W} ${KERBIN_MAP_VB_H}`}
                    preserveAspectRatio={wallSlot ? "none" : KERBIN_MAP_PRESERVE_ASPECT}
                    role="img"
                    aria-label="Kerbin map graticule and click pick overlay"
                  >
                    {/* Approaches, navaid range rings, and aerodrome vector overlays are KERBIN_*, hardcoded
                     * data for the stock home body. They only make sense when the user is viewing
                     * the home body — drawing them on Earth (or Mun, or Eve) would superimpose
                     * Kerbin coordinates on a different planet's surface and look broken.
                     * We deliberately don't gate the graticule or the click-pick (graticule is
                     * generic equirectangular, the click-pick is a user input artifact). */}
                    {mapShowApproaches && isViewingHomeBody ? (
                      <KerbinApproachLayer
                        aerodromes={KERBIN_AERODROMES}
                        markers={ilsMarkers}
                        bodyRadiusKm={homeBodyRadiusKm}
                        mapZoom={mapZoom}
                      />
                    ) : null}
                    {/* Per-aerodrome PLT (vector diagram) buttons. Always on
                     * (regardless of mapShowApproaches) so tower can open the
                     * quick runway/frequency sketch without toggling full ILS
                     * geometry on the map. Home-body only — KKSC/KAFD are
                     * Kerbin-specific aerodromes. */}
                    {isViewingHomeBody ? (
                      <KerbinAerodromeChartButtons
                        aerodromes={KERBIN_AERODROMES}
                        mapZoom={mapZoom}
                        onOpen={(id) => setAerodromeChartId(id)}
                      />
                    ) : null}
                    {mapShowRanges && isViewingHomeBody ? (
                      <g className="kerbin-map-range-rings" pointerEvents="none">
                        {effectiveNavaids
                          .filter((n) =>
                            n.kind === "VOR" ? mapShowVor : n.kind === "ILS" ? mapShowIls : mapShowNdb
                          )
                          .map((n) => {
                            const rangeKm = approxNavaidRangeKm(n.kind, mapRangeAltitudeM);
                            if (rangeKm <= 0) return null;
                            const nav = { lat: n.lat, lon: n.lon };
                            // Convert ground-distance to map-viewBox dimensions. Lat is
                            // unaffected by latitude (1° = R·π/180 km always); lon shrinks
                            // by cos(lat). Clamp the cosine so beacons within ~3° of the
                            // pole still draw a finite ellipse instead of a runaway sliver.
                            const degLat = (rangeKm / homeBodyRadiusKm) * (180 / Math.PI);
                            const cosLat = Math.max(0.05, Math.cos((nav.lat * Math.PI) / 180));
                            const degLon = degLat / cosLat;
                            const ry = degLat * (KERBIN_MAP_VB_H / 180);
                            const rx = degLon * (KERBIN_MAP_VB_W / 360);
                            const { x, y } = latLonToMapVB(nav.lat, nav.lon);
                            const color = navaidDotColor(n.kind);
                            return (
                              <ellipse
                                key={`range-${n.kind}-${n.id}`}
                                cx={x}
                                cy={y}
                                rx={rx}
                                ry={ry}
                                fill="none"
                                stroke={color}
                                strokeOpacity={0.55}
                                strokeWidth={1.1 / mapZoom}
                                strokeDasharray={`${4 / mapZoom} ${3 / mapZoom}`}
                              />
                            );
                          })}
                      </g>
                    ) : null}
                    {/* Graticule line widths are divided by mapZoom because the whole
                     * .kerbin-map-zoom-stack wrapper has a CSS `transform: scale(zoom)`
                     * applied to it — and CSS transforms applied OUTSIDE an <svg> still
                     * scale its strokes (vector-effect="non-scaling-stroke" only ignores
                     * transforms INSIDE the svg, so it doesn't help here). Dividing by
                     * mapZoom pre-shrinks the stroke so the outer CSS scale brings it
                     * back to a constant ~screen-pixel thickness. Without this the
                     * equator goes from ~1 px at 1x to ~250 px at 172x, eating half
                     * the map at runway zoom. */}
                    <g className="kerbin-map-graticule">
                      {KERBIN_MERIDIANS.map((lon) => {
                        const x = lonToMapX(lon);
                        const thick = lon === 0;
                        return (
                          <line
                            key={`m-${lon}`}
                            x1={x}
                            y1={0}
                            x2={x}
                            y2={KERBIN_MAP_VB_H}
                            stroke={thick ? "rgba(248,250,252,0.35)" : "rgba(248,250,252,0.14)"}
                            strokeWidth={(thick ? 1.4 : 0.7) / mapZoom}
                          />
                        );
                      })}
                      {KERBIN_PARALLELS.map((lat) => {
                        const y = latToMapY(lat);
                        const thick = lat === 0;
                        return (
                          <line
                            key={`p-${lat}`}
                            x1={0}
                            y1={y}
                            x2={KERBIN_MAP_VB_W}
                            y2={y}
                            stroke={thick ? "rgba(248,250,252,0.35)" : "rgba(248,250,252,0.14)"}
                            strokeWidth={(thick ? 1.4 : 0.7) / mapZoom}
                          />
                        );
                      })}
                    </g>
                    <g className="kerbin-map-navaids" style={{ display: isViewingHomeBody ? undefined : "none" }}>
                      {effectiveNavaids
                        .filter((n) =>
                          n.kind === "VOR" ? mapShowVor : n.kind === "ILS" ? mapShowIls : mapShowNdb
                        )
                        .map((n) => {
                          const nav = { lat: n.lat, lon: n.lon };
                          const { x, y } = latLonToMapVB(nav.lat, nav.lon);
                          return (
                            <KerbinMapMarkerGroup
                              key={`${n.kind}-${n.id}-${n.frequency}-${n.lat}`}
                              x={x}
                              y={y}
                              mapZoom={mapZoom}
                            >
                              <circle
                                cx={0}
                                cy={0}
                                r={2.4}
                                fill={navaidDotColor(n.kind)}
                                stroke="rgba(15,23,42,0.85)"
                                strokeWidth={0.35}
                              />
                            </KerbinMapMarkerGroup>
                          );
                        })}
                    </g>
                    {mapShowSites && isViewingHomeBody ? (
                      <g className="kerbin-map-launch-sites">
                        {effectiveLaunchSites.map((s) => {
                          const pos = { lat: s.lat, lon: s.lon };
                          const { x, y } = latLonToMapVB(pos.lat, pos.lon);
                          // Airfields render as a horizontal "runway bar" glyph so they read
                          // as alternate landing options at a glance — distinct from the
                          // upward-pointing pad triangle used for vertical launch sites.
                          // KSC players running an un-upgraded tier-1 runway need to see
                          // KAFD / Old Airfield clearly without clicking through pins.
                          return (
                            <KerbinMapMarkerGroup key={`site-${s.id}`} x={x} y={y} mapZoom={mapZoom}>
                              {s.isAirfield ? (
                                <>
                                  <rect
                                    x={-3.6}
                                    y={-0.7}
                                    width={7.2}
                                    height={1.4}
                                    rx={0.3}
                                    fill="#a3e635"
                                    stroke="rgba(15,23,42,0.9)"
                                    strokeWidth={0.4}
                                  />
                                  <line
                                    x1={-3.0}
                                    y1={0}
                                    x2={3.0}
                                    y2={0}
                                    stroke="rgba(15,23,42,0.6)"
                                    strokeWidth={0.25}
                                    strokeDasharray="0.6 0.6"
                                  />
                                </>
                              ) : (
                                <polygon
                                  points="0,-3.2 2.77,1.6 -2.77,1.6"
                                  fill="#38bdf8"
                                  stroke="rgba(15,23,42,0.9)"
                                  strokeWidth={0.4}
                                />
                              )}
                            </KerbinMapMarkerGroup>
                          );
                        })}
                      </g>
                    ) : null}
                    {mapShowAnomalies && liveBakeMatchesView && worldMaps && worldMaps.features.length > 0 ? (
                      <g className="kerbin-map-anomalies">
                        {worldMaps.features
                          .filter((f) => f.kind === "anomaly")
                          .map((f) => {
                            const { x, y } = latLonToMapVB(f.lat, f.lon);
                            // Diamond glyph in muted violet to read distinctly from navaid dots
                            // (warm yellow/teal), launch-site triangles (cyan), and KSC (orange).
                            // Native <title> gives a free hover tooltip with the PQSCity name —
                            // good enough until we wire a proper popover in for picks.
                            return (
                              <KerbinMapMarkerGroup key={`anom-${f.name}-${f.lat}-${f.lon}`} x={x} y={y} mapZoom={mapZoom}>
                                <polygon
                                  points="0,-2.6 2.2,0 0,2.6 -2.2,0"
                                  fill="#a78bfa"
                                  stroke="rgba(15,23,42,0.9)"
                                  strokeWidth={0.4}
                                >
                                  <title>{f.name}</title>
                                </polygon>
                              </KerbinMapMarkerGroup>
                            );
                          })}
                      </g>
                    ) : null}
                    {mapShowKsc && isViewingHomeBody ? (
                      <KerbinMapMarkerGroup
                        className="kerbin-map-ksc-marker"
                        x={latLonToMapVB(homeBaseLat, homeBaseLon).x}
                        y={latLonToMapVB(homeBaseLat, homeBaseLon).y}
                        mapZoom={mapZoom}
                      >
                        <circle
                          cx={0}
                          cy={0}
                          r={3.2}
                          fill="#f59e0b"
                          stroke="rgba(15,23,42,0.9)"
                          strokeWidth={0.45}
                        />
                      </KerbinMapMarkerGroup>
                    ) : null}
                    {mapShowTowerGuidance && isViewingHomeBody && !suppressAircraftOverlay ? (
                      <KerbinTowerGuidanceLayer
                        mapZoom={mapZoom}
                        bodyRadiusKm={homeBodyRadiusKm}
                        homeBaseLat={homeBaseLat}
                        homeBaseLon={homeBaseLon}
                        homeBodyName={homeBodyName}
                      />
                    ) : null}
                    {hasCoords && onHomeBody && telemetry && !mapShowTowerGuidance ? (
                      <KerbinVesselMapMarker
                        cx={latLonToMapVB(telemetry.lat as number, telemetry.lon as number).x}
                        cy={latLonToMapVB(telemetry.lat as number, telemetry.lon as number).y}
                        kind={vesselMapIconKind(telemetry)}
                        mapZoom={mapZoom}
                        headingDeg={vesselHeadingDeg}
                      />
                    ) : null}
                    {mapShowTowerGuidance && isViewingHomeBody && resolvedTowerAircraft.length > 0 ? (
                      <KerbinTowerAircraftStack
                        tracks={resolvedTowerAircraft}
                        mapZoom={mapZoom}
                        homeBodyName={effectiveMapBodyName}
                        bodyRadiusM={homeBodyRadiusM}
                        homeBaseLat={homeBaseLat}
                        homeBaseLon={homeBaseLon}
                        selfHeadingDeg={vesselHeadingDeg}
                      />
                    ) : null}
                    {/* Room-shared waypoints: pins dropped by anyone in the room. We filter by
                        the body currently being viewed so a Kerbin pin doesn't bleed onto the
                        Mun map (and vice-versa). Visual only here — interactions live in the
                        pickpill below to avoid colliding with the map's pan/click handlers. */}
                    {!suppressSharedWaypointPins
                      ? sharedWaypoints
                          .filter(
                            (w) => w.bodyName.toLowerCase() === effectiveMapBodyName.toLowerCase()
                          )
                          .map((w) => {
                            const p = latLonToMapVB(w.lat, w.lon);
                            const fill = w.color ?? "#a78bfa";
                            return (
                              <KerbinMapMarkerGroup key={w.id} x={p.x} y={p.y} mapZoom={mapZoom}>
                                <circle
                                  cx={0}
                                  cy={0}
                                  r={4.2}
                                  fill={fill}
                                  stroke="rgba(15,23,42,0.95)"
                                  strokeWidth={0.9}
                                  pointerEvents="none"
                                />
                                <circle
                                  cx={0}
                                  cy={0}
                                  r={1.4}
                                  fill="rgba(15,23,42,0.9)"
                                  pointerEvents="none"
                                />
                                {w.label ? (
                                  <text
                                    x={6}
                                    y={2}
                                    fontSize={4.4}
                                    fill="#e2e8f0"
                                    stroke="rgba(15,23,42,0.85)"
                                    strokeWidth={0.45}
                                    paintOrder="stroke"
                                    pointerEvents="none"
                                  >
                                    {w.label}
                                  </text>
                                ) : null}
                              </KerbinMapMarkerGroup>
                            );
                          })
                      : null}
                    {(readOnlyOverlayPins ?? [])
                      .filter((pin) => (pin.bodyName ?? homeBodyName).toLowerCase() === effectiveMapBodyName.toLowerCase())
                      .map((pin) => {
                        const p = latLonToMapVB(pin.lat, pin.lon);
                        const fill = pin.color ?? "#fbbf24";
                        return (
                          <KerbinMapMarkerGroup key={pin.id} x={p.x} y={p.y} mapZoom={mapZoom}>
                            <circle
                              cx={0}
                              cy={0}
                              r={5.1}
                              fill={fill}
                              stroke="rgba(15,23,42,0.95)"
                              strokeWidth={0.95}
                              pointerEvents="none"
                            />
                            <circle cx={0} cy={0} r={1.6} fill="rgba(15,23,42,0.92)" pointerEvents="none" />
                            {pin.label ? (
                              <text
                                x={7}
                                y={2}
                                fontSize={4.6}
                                fill="#fff7ed"
                                stroke="rgba(15,23,42,0.88)"
                                strokeWidth={0.48}
                                paintOrder="stroke"
                                pointerEvents="none"
                              >
                                {pin.label}
                              </text>
                            ) : null}
                          </KerbinMapMarkerGroup>
                        );
                      })}
                    {mapClickPick ? (
                      <KerbinMapMarkerGroup
                        x={latLonToMapVB(mapClickPick.lat, mapClickPick.lon).x}
                        y={latLonToMapVB(mapClickPick.lat, mapClickPick.lon).y}
                        mapZoom={mapZoom}
                      >
                        <circle
                          cx={0}
                          cy={0}
                          r={6}
                          fill="none"
                          stroke="#c4b5fd"
                          strokeWidth={1.1}
                          strokeDasharray="4 3"
                          pointerEvents="none"
                        />
                      </KerbinMapMarkerGroup>
                    ) : null}
                  </svg>
                ) : null}
              </div>
              {mapOverlayReady ? (
                <KerbinMapFrameDegreesDynamic ticks={mapFrameTicks} mapZoom={mapZoom} />
              ) : null}
            </div>
          </div>

          <div className="tower-map-toolbar" role="toolbar" aria-label="Map controls">
            <div className="tower-map-toolbar-group" aria-label="Zoom">
              <button
                type="button"
                onClick={() => zoomBy(1 / 1.15)}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <span className="tower-map-zoom-readout" aria-live="polite">
                {Math.round(mapZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => zoomBy(1.15)}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
              <button type="button" onClick={() => mapFit()} title="Fit whole planet with KSC centered">
                Reset
              </button>
            </div>
            {/* ─── Navaids dropdown ──────────────────────────────────────────────────
             * Collapses VOR / ILS / NDB / Range (+ altitude slider) / Approaches into a
             * single popover. The toolbar otherwise grew past the visible width once we
             * added Anomalies + Range + Approaches, and the row was hiding under the
             * MapBodyDropdown's overflow-clip on smaller screens. */}
            <div className="tower-map-toolbar-group" aria-label="Navaids">
              {(() => {
                const navOn: string[] = [];
                if (mapShowVor) navOn.push("VOR");
                if (mapShowIls) navOn.push("ILS");
                if (mapShowNdb) navOn.push("NDB");
                if (mapShowRanges) navOn.push("Range");
                if (mapShowApproaches) navOn.push("Approach");
                if (mapShowTowerGuidance) navOn.push("Guid");
                const summary =
                  navOn.length === 0
                    ? "off"
                    : navOn.length <= 3
                      ? navOn.join(" · ")
                      : `${navOn.length} on`;
                const allDefault =
                  mapShowVor &&
                  mapShowIls &&
                  mapShowNdb &&
                  !mapShowRanges &&
                  !mapShowApproaches &&
                  mapShowTowerGuidance;
                return (
                  <MapToolbarPopover
                    label="Navaids"
                    summary={summary}
                    title="VOR / ILS / NDB beacons, reception-range rings, ILS approach vector overlays, and tower guidance."
                    active={!allDefault}
                    anchor="left"
                  >
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Beacons</p>
                      <div className="tower-map-popover-checks">
                        <label>
                          <input
                            type="checkbox"
                            checked={mapShowVor}
                            onChange={(e) => setMapShowVor(e.target.checked)}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#fb923c" }} aria-hidden />
                          VOR
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={mapShowIls}
                            onChange={(e) => setMapShowIls(e.target.checked)}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#4ade80" }} aria-hidden />
                          ILS
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={mapShowNdb}
                            onChange={(e) => setMapShowNdb(e.target.checked)}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#c4b5fd" }} aria-hidden />
                          NDB
                        </label>
                      </div>
                    </div>
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Range rings</p>
                      <label
                        className="tower-map-popover-check-block"
                        title="Draw the published reception-range ring around each visible beacon. Radius scales with the receiver-altitude slider (see kerbinAeroCharts approxNavaidRangeKm)."
                      >
                        <input
                          type="checkbox"
                          checked={mapShowRanges}
                          onChange={(e) => setMapShowRanges(e.target.checked)}
                        />
                        Show range circles
                      </label>
                      {mapShowRanges ? (
                        <label
                          className="tower-map-range-altitude tower-map-popover-slider"
                          title="Receiver altitude (m ASL) the rings are sized for."
                        >
                          <span className="tower-map-popover-slider-label">Receiver alt</span>
                          <input
                            type="range"
                            min={500}
                            max={30000}
                            step={500}
                            value={mapRangeAltitudeM}
                            onChange={(e) => setMapRangeAltitudeM(Number(e.target.value))}
                            aria-label="Receiver altitude for range rings"
                          />
                          <span className="tower-map-range-altitude-readout">
                            {(mapRangeAltitudeM / 1000).toFixed(mapRangeAltitudeM < 10000 ? 1 : 0)} km
                          </span>
                        </label>
                      ) : null}
                    </div>
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Approaches</p>
                      <label
                        className="tower-map-popover-check-block"
                        title="Draw KKSC + KAFD runways, extended approach centerlines, OM/MM/IM marker beacons, and the missed-approach turn point as native vector geometry (data from kerbinAeroCharts / kerbinIlsMarkersComputed)."
                      >
                        <input
                          type="checkbox"
                          checked={mapShowApproaches}
                          onChange={(e) => setMapShowApproaches(e.target.checked)}
                        />
                        ILS approach overlay
                      </label>
                    </div>
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Tower</p>
                      <label
                        className="tower-map-popover-check-block"
                        title="KSC distance rings (5–30 km), final approach cones and extended centerlines for KKSC 09/27, and live label blocks for every aircraft on the home body."
                      >
                        <input
                          type="checkbox"
                          checked={mapShowTowerGuidance}
                          onChange={(e) => setMapShowTowerGuidance(e.target.checked)}
                        />
                        Tower guidance (rings, cones, labels)
                      </label>
                    </div>
                  </MapToolbarPopover>
                );
              })()}
            </div>

            {/* ─── Sites dropdown ────────────────────────────────────────────────────
             * KSC + Sites + Anomalies visibility, plus a per-site "Go" list that pans
             * and zooms the map to that site. Pre-dropdown, getting from a 100% world
             * view to KAFD or Woomerang meant pinch-zooming and dragging across half
             * the map; now it's one click from the toolbar. */}
            <div className="tower-map-toolbar-group" aria-label="Sites">
              {(() => {
                const sitesOn: string[] = [];
                if (mapShowKsc) sitesOn.push("KSC");
                if (mapShowSites) sitesOn.push("Sites");
                if (mapShowAnomalies) sitesOn.push("Anomalies");
                const summary =
                  sitesOn.length === 0 ? "off" : sitesOn.length === 3 ? "all" : sitesOn.join(" · ");
                const allDefault = mapShowKsc && mapShowSites && mapShowAnomalies;
                const anomaliesAvailable = !!worldMaps && worldMaps.features.length > 0;
                return (
                  <MapToolbarPopover
                    label="Sites"
                    summary={summary}
                    title="KSC, launch sites, and surface anomalies. Pick a site to jump the map to it."
                    active={!allDefault}
                    anchor="left"
                  >
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Show on map</p>
                      <div className="tower-map-popover-checks tower-map-popover-checks-stack">
                        <label>
                          <input
                            type="checkbox"
                            checked={mapShowKsc}
                            onChange={(e) => setMapShowKsc(e.target.checked)}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#f59e0b" }} aria-hidden />
                          KSC
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={mapShowSites}
                            onChange={(e) => setMapShowSites(e.target.checked)}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#38bdf8" }} aria-hidden />
                          Launch sites &amp; airfields
                        </label>
                        <label
                          className={anomaliesAvailable ? undefined : "tower-map-popover-disabled"}
                          title={
                            anomaliesAvailable
                              ? "Mark surface anomalies extracted from the in-game PQSCity list (Mun arches, KSC2, monoliths, the Duna face, modded easter eggs)."
                              : "No anomalies published for this session yet — start KSP and reach the Space Center to populate the live world-maps bake."
                          }
                        >
                          <input
                            type="checkbox"
                            checked={mapShowAnomalies}
                            onChange={(e) => setMapShowAnomalies(e.target.checked)}
                            disabled={!anomaliesAvailable}
                          />
                          <span className="tower-map-popover-dot" style={{ background: "#a78bfa" }} aria-hidden />
                          Anomalies
                        </label>
                      </div>
                    </div>
                    <div className="tower-map-popover-section">
                      <p className="tower-map-popover-heading">Go to</p>
                      <ul className="tower-map-popover-goto">
                        {isViewingHomeBody ? (
                          <li>
                            <button
                              type="button"
                              className="tower-map-popover-goto-btn"
                              onClick={() => panToLatLon(homeBaseLat, homeBaseLon, 24)}
                              title={`Center on KSC (${homeBaseLat.toFixed(3)}°, ${homeBaseLon.toFixed(3)}°)`}
                            >
                              <span className="tower-map-popover-dot" style={{ background: "#f59e0b" }} aria-hidden />
                              <span className="tower-map-popover-goto-name">KSC</span>
                              <span className="tower-map-popover-goto-coord">home base</span>
                            </button>
                          </li>
                        ) : null}
                        {isViewingHomeBody && effectiveLaunchSites.length > 0
                          ? effectiveLaunchSites.map((s) => (
                              <li key={`goto-${s.id}`}>
                                <button
                                  type="button"
                                  className="tower-map-popover-goto-btn"
                                  onClick={() => {
                                    const pan = { lat: s.lat, lon: s.lon };
                                    panToLatLon(pan.lat, pan.lon, s.isAirfield ? 28 : 18);
                                  }}
                                  title={s.blurb ?? `Center on ${s.name}`}
                                >
                                  <span
                                    className={`tower-map-popover-glyph ${s.isAirfield ? "tower-map-popover-glyph-airfield" : "tower-map-popover-glyph-pad"}`}
                                    aria-hidden
                                  />
                                  <span className="tower-map-popover-goto-name">{s.name}</span>
                                  <span className="tower-map-popover-goto-coord">
                                    {s.lat.toFixed(2)}°, {s.lon.toFixed(2)}°
                                  </span>
                                </button>
                              </li>
                            ))
                          : null}
                        {!isViewingHomeBody ? (
                          <li className="tower-map-popover-empty">
                            Switch back to the home body to jump to its launch sites.
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  </MapToolbarPopover>
                );
              })()}
            </div>

            {/* ─── Map type dropdown ─────────────────────────────────────────────────
             * Alt / Biome / Slope / Schematic basemap radio. Was a flat group on the
             * toolbar; folded into a popover so the toolbar fits on one row. The pip
             * (live=green / static=muted) moves into the popover next to each radio. */}
            <div className="tower-map-toolbar-group" aria-label="Map type">
              {(() => {
                const layerLabel =
                  basemapLayerPref === "schematic"
                    ? "Schematic"
                    : basemapLayerPref === "alt"
                      ? "Alt"
                      : basemapLayerPref === "biome"
                        ? "Biome"
                        : "Slope";
                const titleText = worldMaps
                  ? `Live in-game bake of ${worldMaps.body.displayName} (${Math.max(
                      0,
                      Math.floor(Date.now() / 1000) - worldMaps.receivedAt
                    )}s ago).`
                  : basemap?.layers
                    ? "Pre-baked Alt / Biome / Slope variants from the bundled basemap."
                    : "No live PQS bake published yet — only the bundled schematic plate is available.";
                return (
                  <MapToolbarPopover
                    label="Map type"
                    summary={layerLabel}
                    title={titleText}
                    active={basemapLayerPref !== "alt"}
                  >
                    <div
                      className="tower-map-basemap-layer tower-map-popover-radio-list"
                      role="radiogroup"
                      aria-label="Basemap layer"
                    >
                      {(["alt", "biome", "slope"] as const).map((layerId) => {
                        const liveLayer: WorldMapsLayer | null =
                          worldMaps?.layers.find((l) => l.id === layerId) ?? null;
                        const staticOverride = basemap?.layers?.[layerId] ?? null;
                        const staticImplicitAlt = layerId === "alt" && basemap != null;
                        const enabled =
                          liveLayer != null || staticOverride != null || staticImplicitAlt;
                        const source = liveLayer
                          ? "live"
                          : staticOverride || staticImplicitAlt
                            ? "static"
                            : "none";
                        const checked = basemapLayerPref === layerId;
                        const labelText =
                          liveLayer?.label ??
                          (layerId === "alt" ? "Alt" : layerId === "biome" ? "Biome" : "Slope");
                        const tooltip =
                          source === "live"
                            ? `${labelText} · ${(liveLayer!.bytes / 1024).toFixed(0)} KB · in-game bake`
                            : source === "static"
                              ? `${labelText} · bundled basemap (no live bake)`
                              : `${labelText} layer not available for this session.`;
                        const sourcePipColor =
                          source === "live"
                            ? "#22c55e"
                            : source === "static"
                              ? "#94a3b8"
                              : "transparent";
                        const sourcePipLabel =
                          source === "live" ? "live" : source === "static" ? "static" : "n/a";
                        return (
                          <label
                            key={layerId}
                            className={enabled ? undefined : "tower-map-basemap-layer-disabled"}
                            title={tooltip}
                          >
                            <input
                              type="radio"
                              name={`basemap-layer-${persistKey ?? "x"}`}
                              value={layerId}
                              checked={checked}
                              disabled={!enabled}
                              onChange={() => setBasemapLayerPref(layerId)}
                            />
                            {labelText}
                            <span
                              className="tower-map-basemap-layer-pip"
                              style={{ background: sourcePipColor }}
                              aria-label={`source: ${sourcePipLabel}`}
                              title={`source: ${sourcePipLabel}`}
                            />
                          </label>
                        );
                      })}
                      <label title="Bundled schematic plate (no live PQS bake).">
                        <input
                          type="radio"
                          name={`basemap-layer-${persistKey ?? "x"}`}
                          value="schematic"
                          checked={basemapLayerPref === "schematic"}
                          onChange={() => setBasemapLayerPref("schematic")}
                        />
                        Schematic
                      </label>
                    </div>
                  </MapToolbarPopover>
                );
              })()}
            </div>
            <div className="tower-map-toolbar-group" aria-label="Map body">
              <MapBodyDropdown
                liveWorldId={worldInventory?.worldId ?? null}
                liveHomeName={(worldInventory?.home.name ?? "Kerbin").trim()}
                liveHomeDisplay={
                  worldInventory?.home.displayName ?? (worldInventory?.home.name ?? "Kerbin").trim()
                }
                hasLiveInventory={!!worldInventory}
                modCount={worldInventory?.mods.length ?? 0}
                selectedPilotLabel={telemetry ? aircraftPrimaryLabel(telemetry) : null}
                currentBodyName={telemetry?.bodyName ?? null}
                currentBodyDisplay={null}
                mapBodyPref={mapBodyPref}
                setMapBodyPref={setMapBodyPref}
                focusedBodyName={mapBodyPref === "auto" ? null : mapBodyPref}
                setFocusedBodyName={onPickFocus}
                vesselCounts={vesselCounts}
              />
            </div>
          </div>

          {mapClickPick ? (
            <div className="tower-map-pickpill" role="status">
              <div className="tower-map-pickpill-row">
                <strong>{mapClickPick.lat.toFixed(4)}°</strong> lat ·{" "}
                <strong>{mapClickPick.lon.toFixed(4)}°</strong> lon
              </div>
              <div className="tower-map-pickpill-row tower-map-pickpill-dms">
                {formatDms(mapClickPick.lat, "N", "S")} ·{" "}
                {formatDms(mapClickPick.lon, "E", "W")}
              </div>
              <div className="tower-map-pickpill-row tower-map-pickpill-meta">
                <span>
                  <span className="tower-map-pickpill-label">Biome:</span>{" "}
                  {mapClickPickInfo?.biomeSource === "unavailable"
                    ? `n/a for ${effectiveMapBodyName}`
                    : mapClickPickInfo?.biome
                      ? `${mapClickPickInfo.biome} (proxy)`
                      : "…"}
                </span>
                <span>
                  <span className="tower-map-pickpill-label">Slope:</span>{" "}
                  {mapClickPickInfo?.slopeSource === "unavailable"
                    ? `n/a for ${effectiveMapBodyName}`
                    : mapClickPickInfo?.slope
                      ? `${mapClickPickInfo.slope} (proxy)`
                      : "…"}
                </span>
              </div>
              <div className="tower-map-pickpill-row tower-map-pickpill-actions">
                <button
                  type="button"
                  className="tower-map-pickpill-btn"
                  title="Copy 'lat,lon' to clipboard (paste into nav mods, GPS, or chat)"
                  onClick={() => {
                    const text = `${mapClickPick.lat.toFixed(5)},${mapClickPick.lon.toFixed(5)}`;
                    void navigator.clipboard?.writeText(text);
                  }}
                >
                  Copy GPS
                </button>
                <button
                  type="button"
                  className="tower-map-pickpill-btn tower-map-pickpill-btn-primary"
                  disabled={
                    !sessionId.trim() || addWaypointMutation.isPending || !isViewingHomeBody
                  }
                  title={
                    !sessionId.trim()
                      ? "No active session — waypoints are room-scoped"
                      : !isViewingHomeBody
                        ? `Viewing ${effectiveMapBodyName} but the active vessel is on ${homeBodyName}; waypoints attach to the body you're viewing.`
                        : "Drop a pin visible to everyone in this room (pilot, controller, spectators)."
                  }
                  onClick={() => {
                    addWaypointMutation.mutate({
                      lat: mapClickPick.lat,
                      lon: mapClickPick.lon,
                      bodyName: effectiveMapBodyName
                    });
                  }}
                >
                  {addWaypointMutation.isPending ? "Adding…" : "Add room waypoint"}
                </button>
                <button
                  type="button"
                  className="tower-map-pickpill-btn"
                  disabled
                  title="Pushing waypoints to KSP's in-game navball is not yet wired (requires plugin update — TODO)."
                >
                  Send to KSP
                </button>
                <button
                  type="button"
                  className="kerbin-map-click-clear"
                  onClick={() => setMapClickPick(null)}
                >
                  Clear
                </button>
              </div>
              {addWaypointMutation.isError ? (
                <div className="tower-map-pickpill-row tower-map-pickpill-error" role="alert">
                  Couldn’t add waypoint: {addWaypointMutation.error.message}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* Room waypoint list: small card with one row per pin (label, lat/lon, delete).
              Rendered separately from the click pickpill so the operator can manage existing
              pins without first having to click the map again. Filtered by the body currently
              being viewed so the list matches what's visible. */}
          {sharedWaypoints.filter(
            (w) => w.bodyName.toLowerCase() === effectiveMapBodyName.toLowerCase()
          ).length > 0 ? (
            <div className="tower-map-waypoints" role="list" aria-label="Room waypoints">
              <div className="tower-map-waypoints-title">
                Room waypoints ({effectiveMapBodyName})
              </div>
              {sharedWaypoints
                .filter(
                  (w) => w.bodyName.toLowerCase() === effectiveMapBodyName.toLowerCase()
                )
                .map((w) => (
                  <div className="tower-map-waypoints-row" role="listitem" key={w.id}>
                    <span
                      className="tower-map-waypoints-swatch"
                      style={{ background: w.color ?? "#a78bfa" }}
                      aria-hidden
                    />
                    <span className="tower-map-waypoints-label">
                      {w.label ?? `${w.lat.toFixed(3)}°, ${w.lon.toFixed(3)}°`}
                    </span>
                    <button
                      type="button"
                      className="tower-map-waypoints-remove"
                      title="Remove this waypoint for everyone in the room"
                      disabled={removeWaypointMutation.isPending}
                      onClick={() => removeWaypointMutation.mutate({ waypointId: w.id })}
                    >
                      ×
                    </button>
                  </div>
                ))}
            </div>
          ) : null}
          <KerbinMapLegend
            layer={basemapLayerPref}
            isLive={
              basemapLayerPref !== "schematic" &&
              liveBakeMatchesView &&
              worldMaps?.layers.some((l) => l.id === basemapLayerPref) === true
            }
            liveBodyDisplay={worldMaps?.body.displayName ?? null}
          />
        </div>
      </div>

    </>
  );
}
