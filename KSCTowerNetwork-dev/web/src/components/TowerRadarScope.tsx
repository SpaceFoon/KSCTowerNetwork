import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import {
  launchSitesForHomeBody,
  navaidsForHomeBody,
  type WorldInventory
} from "../data/worldInventoryClient";
import { queryKeys } from "../query/client";
import { useApiQuery } from "../query/hooks";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";
import { buildTowerAircraftTracks, trimmedPilotCallsign, type ActiveAircraftWire } from "../tower/towerAircraftTracks";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";
import {
  kerbinDistanceMeters,
  KERBIN_RADIUS_M,
  KSC_LAT,
  KSC_LON,
  type Telemetry,
  type TowerAircraftTrack
} from "./KerbinTowerMap";

/** PPI range from the selected airfield reference (e.g. published KSC coords on Kerbin). */
export const TOWER_RADAR_RANGE_KM = 100;

/* Room for compass letters + bezel outside the clipped face. */
const VB = 440;
const CX = VB / 2;
const CY = VB / 2;
const R_MAX = 172;
const SWEEP_OPEN_DEG = 40;
/** One sector sweep: hub → this radius (past rim); face uses a matching mask hole so it stays one piece under UI). */
const R_WAVE_OUT = R_MAX + 36;
/** Opaque ring past the glass: covers sweep in the bezel gutter so it never sits on top of the grey rim. */
const R_CHASSIS_RING_OUT = R_WAVE_OUT + 10;

const RADAR_ZOOM_MIN = 1;
const RADAR_ZOOM_MAX = 4.5;
const RADAR_ZOOM_BTN = 1.28;
const RADAR_ZOOM_WHEEL = 1.12;

/** Full rotation of the PPI sweep (matches prior SMIL `dur`). */
const SWEEP_PERIOD_MS = 2800;
/** Angular slices for the fading tail (leading edge = high index). */
const SWEEP_TAIL_SLICES = 10;

/** PPI plot: latched position updates only when the sweep passes the drawn blip (classic radar paint). */
type RadarPlotTruth = {
  id: string;
  callsign: string;
  x: number;
  y: number;
  phiRad: number;
  distKm: number;
  inRange: boolean;
  isSelf?: boolean;
  /** When the drawn dot was last painted from truth (for age fade until next sweep). */
  paintCommitMs?: number;
};

type RadarLatchedPos = {
  x: number;
  y: number;
  phiRad: number;
  distKm: number;
  inRange: boolean;
  /** Last time displayed geometry matched fresh telemetry (initial paint or post-sweep commit). */
  commitMs: number;
};

/** `blipSweepGlow` at/above this ⇒ commit pending telemetry to the drawn dot (leading edge over the blip). */
const RADAR_PLOT_LATCH_COMMIT_GLOW = 0.88;
const RADAR_PLOT_MOVE_EPS_PX = 0.45;
const RADAR_PLOT_MOVE_EPS_KM = 0.02;

function radarPlotPositionMoved(truth: { x: number; y: number; distKm: number }, lat: RadarLatchedPos): boolean {
  return (
    Math.abs(truth.x - lat.x) > RADAR_PLOT_MOVE_EPS_PX ||
    Math.abs(truth.y - lat.y) > RADAR_PLOT_MOVE_EPS_PX ||
    Math.abs(truth.distKm - lat.distKm) > RADAR_PLOT_MOVE_EPS_KM
  );
}

/** PPI dot radius (user space); in-range vs beyond ring. */
const RADAR_BLIP_R_IN = 3.6;
const RADAR_BLIP_R_OOR = 3;

/** SVG `font-size` in **user units** (scales with `viewBox` zoom); avoid CSS `px` on PPI text. */
const RADAR_U_FONT_RING = 11;
const RADAR_U_FONT_RING_MAX = 10;
const RADAR_U_FONT_CARDINAL = 15;
const RADAR_U_FONT_BLIP = 10;

/** Fade painted returns after `commitMs` until the next sweep repaint (~2× sweep period → floor). */
const RADAR_BLIP_AGE_FADE_FLOOR = 0.2;
const RADAR_BLIP_AGE_FADE_MAX_MS = SWEEP_PERIOD_MS * 2.15;

function radarBlipAgeFade(commitMs: number, nowMs: number): number {
  if (!Number.isFinite(commitMs) || !Number.isFinite(nowMs)) return 1;
  const age = Math.max(0, nowMs - commitMs);
  if (age >= RADAR_BLIP_AGE_FADE_MAX_MS) return RADAR_BLIP_AGE_FADE_FLOOR;
  const t = age / RADAR_BLIP_AGE_FADE_MAX_MS;
  return RADAR_BLIP_AGE_FADE_FLOOR + (1 - RADAR_BLIP_AGE_FADE_FLOOR) * (1 - t * t);
}

type RadarTrailPoint = { x: number; y: number; t: number };

/** Sample PPI trail when painted position moves (user units). */
const RADAR_TRAIL_MIN_SAMPLE_DIST = 0.85;
/** Drop samples older than this (ms). */
const RADAR_TRAIL_MAX_AGE_MS = 24_000;
const RADAR_TRAIL_MAX_POINTS = 72;
const RADAR_TRAIL_DOT_R = 1.05;

/** Older returns dimmer (0..1 multiplier on base trail fill). */
function radarTrailDotOpacity(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0.38;
  const t = Math.min(1, ageMs / RADAR_TRAIL_MAX_AGE_MS);
  return 0.07 + 0.4 * (1 - t);
}

function clampRadarPan(z: number, px: number, py: number): { x: number; y: number } {
  const zz = Math.min(RADAR_ZOOM_MAX, Math.max(RADAR_ZOOM_MIN, z));
  if (zz <= 1.0001) return { x: 0, y: 0 };
  const w = VB / zz;
  const pad = Math.min(160, w * 0.55);
  const minL = -pad;
  const maxL = VB - w + pad;
  const left0 = CX - w / 2;
  return {
    x: Math.max(minL - left0, Math.min(maxL - left0, px)),
    y: Math.max(minL - left0, Math.min(maxL - left0, py))
  };
}

/**
 * PPI origin: Kerbin defaults to published KSC (`KSC_LAT`/`KSC_LON`). `ppiOriginId` may select
 * another **home-body** launch site from world-inventory (`site:<id>` or bare id). Non-Kerbin
 * defaults stay navaid / first-site unless a matching launch site override is set.
 */
function radarPpiOrigin(
  worldInventory: WorldInventory | null,
  ppiOriginId?: string | null
): {
  lat: number;
  lon: number;
  radiusM: number;
  bodyName: string;
  originLabel: string;
} {
  const radiusM = worldInventory?.home.radiusM ?? KERBIN_RADIUS_M;
  const bodyName = worldInventory?.home.name ?? "Kerbin";
  const homeLc = bodyName.trim().toLowerCase();

  const raw = ppiOriginId != null ? String(ppiOriginId).trim() : "";
  if (raw.length > 0 && raw.toLowerCase() !== "ksc") {
    const sites = worldInventory ? launchSitesForHomeBody(worldInventory) : [];
    let siteKey = raw;
    if (raw.toLowerCase().startsWith("site:")) {
      siteKey = raw.slice(5).trim();
    }
    if (siteKey.length > 0) {
      const hit = sites.find((s) => s.id.toLowerCase() === siteKey.toLowerCase());
      if (hit) {
        const lab = (hit.name && hit.name.trim()) || hit.id;
        return { lat: hit.lat, lon: hit.lon, radiusM, bodyName, originLabel: lab };
      }
    }
  }

  if (homeLc === "kerbin") {
    return { lat: KSC_LAT, lon: KSC_LON, radiusM, bodyName, originLabel: "KSC" };
  }

  const navaids = worldInventory ? navaidsForHomeBody(worldInventory) : [];
  const sites = worldInventory ? launchSitesForHomeBody(worldInventory) : [];
  const center =
    navaids.find((n) => n.id === "KST") ?? navaids.find((n) => n.name.toUpperCase() === "CENTER");
  if (center) {
    return { lat: center.lat, lon: center.lon, radiusM, bodyName, originLabel: "TWR" };
  }
  const first = sites[0];
  if (first) {
    return { lat: first.lat, lon: first.lon, radiusM, bodyName, originLabel: first.id };
  }
  return { lat: KSC_LAT, lon: KSC_LON, radiusM, bodyName, originLabel: "KSC" };
}

/** Initial true bearing from (lat0,lon0) to (lat1,lon1), 0° = north, 90° = east. */
function bearingDeg(lat0: number, lon0: number, lat1: number, lon1: number): number {
  const φ1 = (lat0 * Math.PI) / 180;
  const φ2 = (lat1 * Math.PI) / 180;
  const Δλ = ((lon1 - lon0) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (((θ * 180) / Math.PI) + 360) % 360;
}

function sweepEdgeAngles(): { θ0: number; θ1: number } {
  const open = (SWEEP_OPEN_DEG * Math.PI) / 180;
  const θ0 = -Math.PI / 2;
  const θ1 = θ0 + open;
  return { θ0, θ1 };
}

/** Full sector for mask cutout (opaque sweep hole in face). */
function sweepSectorPath(): string {
  const { θ0, θ1 } = sweepEdgeAngles();
  const largeArc = SWEEP_OPEN_DEG > 180 ? 1 : 0;
  const x0 = CX + R_WAVE_OUT * Math.cos(θ0);
  const y0 = CY + R_WAVE_OUT * Math.sin(θ0);
  const x1 = CX + R_WAVE_OUT * Math.cos(θ1);
  const y1 = CY + R_WAVE_OUT * Math.sin(θ1);
  return `M ${CX} ${CY} L ${x0} ${y0} A ${R_WAVE_OUT} ${R_WAVE_OUT} 0 ${largeArc} 1 ${x1} ${y1} Z`;
}

/** Narrow pie slices from trailing → leading; opacity ramps up (fading cone behind the bar). */
function sweepTailSlices(): Array<{ d: string; opacity: number }> {
  const { θ0, θ1 } = sweepEdgeAngles();
  const largeArc = 0;
  const span = θ1 - θ0;
  const out: Array<{ d: string; opacity: number }> = [];
  for (let i = 0; i < SWEEP_TAIL_SLICES; i++) {
    const a0 = θ0 + (span * i) / SWEEP_TAIL_SLICES;
    const a1 = θ0 + (span * (i + 1)) / SWEEP_TAIL_SLICES;
    const x0 = CX + R_WAVE_OUT * Math.cos(a0);
    const y0 = CY + R_WAVE_OUT * Math.sin(a0);
    const x1 = CX + R_WAVE_OUT * Math.cos(a1);
    const y1 = CY + R_WAVE_OUT * Math.sin(a1);
    const d = `M ${CX} ${CY} L ${x0} ${y0} A ${R_WAVE_OUT} ${R_WAVE_OUT} 0 ${largeArc} 1 ${x1} ${y1} Z`;
    const t = i / Math.max(1, SWEEP_TAIL_SLICES - 1);
    const opacity = 0.03 + t * t * 0.42;
    out.push({ d, opacity });
  }
  return out;
}

/** 0 = not in beam, 1 = at leading edge (blip brightens as the sweep passes). */
function blipSweepGlow(phiRad: number, sweepRad: number): number {
  if (!Number.isFinite(phiRad) || !Number.isFinite(sweepRad)) return 0;
  const { θ0, θ1 } = sweepEdgeAngles();
  const trail = θ0 + sweepRad;
  const open = θ1 - θ0;
  const twoPi = 2 * Math.PI;
  const norm = (a: number) => ((a % twoPi) + twoPi) % twoPi;
  const p = norm(phiRad);
  const t0 = norm(trail);
  let delta = p - t0;
  if (delta < 0) delta += twoPi;
  if (delta > open + 0.03) return 0;
  const u = delta / open;
  return Math.pow(Math.max(0, u), 1.65);
}

function chassisRingDonutPath(cx: number, cy: number, rIn: number, rOut: number): string {
  return (
    `M ${cx + rOut} ${cy} A ${rOut} ${rOut} 0 1 1 ${cx - rOut} ${cy} A ${rOut} ${rOut} 0 1 1 ${cx + rOut} ${cy} Z ` +
    `M ${cx + rIn} ${cy} A ${rIn} ${rIn} 0 1 0 ${cx - rIn} ${cy} A ${rIn} ${rIn} 0 1 0 ${cx + rIn} ${cy} Z`
  );
}

type ActiveAircraftRes = { ok?: boolean; aircraft?: ActiveAircraftWire[] };

/**
 * Blip tag: other aircraft use telemetry callsign when set.
 * **Self** prefers session pilot callsign — telemetry often carries the tuned **radio facility**
 * ID (e.g. KSC-TWR), not the pilot callsign shown in-game.
 */
function radarBlipCallsign(tr: TowerAircraftTrack, sessionCallsign: unknown): string {
  if (tr.isSelf) {
    const s = trimmedPilotCallsign(sessionCallsign);
    if (s) return s;
  }
  const fromTel = trimmedPilotCallsign(tr.telemetry.callsign);
  if (fromTel) return fromTel;
  return tr.label;
}

type TowerRadarWallSlotProps = {
  sessionId: string;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
  /** Wall-persisted PPI hub (`site:<launchSiteId>` or omit for KSC on Kerbin). */
  radarPpiOriginId?: string;
  /** When set, show hub picker (wall); omitted e.g. embeds without layout persistence. */
  onPpiOriginIdChange?: (ppiOriginSelectValue: string) => void;
};

/**
 * Airfield-centered PPI: 100 km radius from a **published or inventory launch-pad** on the home body.
 * rotating sweep, traffic from session + `/v1/tower/active-aircraft`.
 */
export function TowerRadarWallSlot({
  sessionId,
  worldInventory,
  homeBodyName,
  radarPpiOriginId,
  onPpiOriginIdChange
}: TowerRadarWallSlotProps): JSX.Element {
  const clipId = useId().replace(/:/g, "");
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const refPt = useMemo(
    () => radarPpiOrigin(worldInventory, radarPpiOriginId),
    [worldInventory, radarPpiOriginId]
  );

  const ppiHubOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [{ value: "ksc", label: "KSC (published)" }];
    if (!worldInventory) return out;
    const sites = launchSitesForHomeBody(worldInventory);
    for (const s of sites) {
      const id = s.id?.trim();
      if (!id) continue;
      const name = s.name?.trim();
      const label = name && name.toLowerCase() !== id.toLowerCase() ? `${name} (${id})` : name || id;
      out.push({ value: `site:${id}`, label });
    }
    return out;
  }, [worldInventory]);

  const ppiHubSelectValue = useMemo(() => {
    const raw = radarPpiOriginId?.trim();
    if (!raw) return "ksc";
    const norm = raw.toLowerCase().startsWith("site:") ? raw : `site:${raw}`;
    const hit = ppiHubOptions.find(
      (o) => o.value === raw || o.value === norm || o.value.toLowerCase() === norm.toLowerCase()
    );
    return hit?.value ?? "ksc";
  }, [radarPpiOriginId, ppiHubOptions]);

  type SessionRes = { ok?: boolean; session?: { callsign?: string; telemetry?: Telemetry | null } };
  const sessionQuery = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });
  const telemetry = sessionQuery.data?.session?.telemetry ?? null;

  const aircraftQuery = useApiQuery<ActiveAircraftRes>({
    queryKey: queryKeys.tower.activeAircraft(),
    path: "/v1/tower/active-aircraft",
    refetchInterval: liveConnected ? false : 3_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const activeAircraft = aircraftQuery.data?.aircraft ?? [];

  /**
   * Wall may pass `""` / whitespace for `homeBodyName` while inventory is loading.
   * `??` does not treat `""` as missing — that made `homeLc` in `buildTowerAircraftTracks` `""`
   * so no track matched Kerbin and the PPI showed zero blips.
   */
  const effectiveHome =
    homeBodyName != null && String(homeBodyName).trim().length > 0
      ? String(homeBodyName).trim()
      : refPt.bodyName;

  const homeLc = effectiveHome.toLowerCase();
  const tracks = useMemo((): TowerAircraftTrack[] => {
    return buildTowerAircraftTracks({
      homeBodyName: effectiveHome,
      sessionId: sessionId.trim(),
      telemetry,
      selfCallsign: sessionQuery.data?.session?.callsign,
      active: activeAircraft
    });
  }, [effectiveHome, sessionId, telemetry, sessionQuery.data?.session?.callsign, activeAircraft]);

  const sessionCallsign = sessionQuery.data?.session?.callsign;
  const truthPlots = useMemo((): RadarPlotTruth[] => {
    const out: RadarPlotTruth[] = [];
    for (const tr of tracks) {
      const t = tr.telemetry;
      if (t.lat == null || t.lon == null) continue;
      const tb = (t.bodyName?.trim() || effectiveHome).toLowerCase();
      if (tb !== homeLc) continue;
      const dM = kerbinDistanceMeters(refPt.lat, refPt.lon, t.lat, t.lon, refPt.radiusM);
      const dKm = dM / 1000;
      const brg = bearingDeg(refPt.lat, refPt.lon, t.lat, t.lon);
      const br = (brg * Math.PI) / 180;
      const inRange = dKm <= TOWER_RADAR_RANGE_KM;
      const rNorm = inRange ? dKm / TOWER_RADAR_RANGE_KM : 1;
      const rPx = rNorm * R_MAX;
      const x = CX + rPx * Math.sin(br);
      const y = CY - rPx * Math.cos(br);
      const phiRad = Math.atan2(y - CY, x - CX);
      out.push({
        id: tr.id,
        callsign: radarBlipCallsign(tr, sessionCallsign),
        x,
        y,
        phiRad,
        distKm: dKm,
        inRange,
        isSelf: tr.isSelf
      });
    }
    return out;
  }, [tracks, refPt.lat, refPt.lon, refPt.radiusM, effectiveHome, sessionCallsign]);

  const ringFracs = [0.25, 0.5, 0.75, 1];
  const tickDegs = useMemo(() => {
    const out: number[] = [];
    for (let d = 0; d < 360; d += 30) out.push(d);
    return out;
  }, []);

  const sweepSlices = useMemo(() => sweepTailSlices(), []);
  const [, sweepPulse] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let id = 0;
    const tick = () => {
      sweepPulse();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomportRef = useRef<HTMLDivElement>(null);
  const dragPanRef = useRef(false);
  /** Drawn PPI positions; truth comes from `truthPlots` but x/y/dist update only on sweep paint. */
  const plotLatchRef = useRef<Map<string, RadarLatchedPos>>(new Map());
  /** Past painted positions per track (decayed in render). */
  const trailHistoryRef = useRef<Map<string, RadarTrailPoint[]>>(new Map());

  const ppiHubKey = `${refPt.bodyName}\0${refPt.lat}\0${refPt.lon}\0${refPt.originLabel}`;
  useEffect(() => {
    plotLatchRef.current.clear();
    trailHistoryRef.current.clear();
  }, [ppiHubKey]);

  const viewBoxStr = useMemo(() => {
    const z = Math.min(RADAR_ZOOM_MAX, Math.max(RADAR_ZOOM_MIN, zoom));
    if (z <= 1.0001) {
      return `0 0 ${VB} ${VB}`;
    }
    const w = VB / z;
    const h = VB / z;
    const left = CX - w / 2 + pan.x;
    const top = CY - h / 2 + pan.y;
    return `${left} ${top} ${w} ${h}`;
  }, [zoom, pan]);

  useEffect(() => {
    if (zoom <= 1.0001) {
      setPan({ x: 0, y: 0 });
    } else {
      setPan((p) => clampRadarPan(zoom, p.x, p.y));
    }
  }, [zoom]);

  useEffect(() => {
    const el = zoomportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const up = e.deltaY < 0;
      const factor = up ? RADAR_ZOOM_WHEEL : 1 / RADAR_ZOOM_WHEEL;
      setZoom((prev) => {
        const next = Math.min(RADAR_ZOOM_MAX, Math.max(RADAR_ZOOM_MIN, prev * factor));
        return next < 1.001 ? 1 : next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const resetRadarView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (zoom <= 1.0001) return;
      if (e.button !== 0) return;
      dragPanRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [zoom]
  );

  const onSvgPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragPanRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragPanRef.current || zoom <= 1.0001) return;
      const r = e.currentTarget.getBoundingClientRect();
      const z = Math.min(RADAR_ZOOM_MAX, Math.max(RADAR_ZOOM_MIN, zoom));
      const w = VB / z;
      const k = w / Math.max(1, r.width);
      setPan((p) => clampRadarPan(zoom, p.x - e.movementX * k, p.y - e.movementY * k));
    },
    [zoom]
  );

  const zoomOutDisabled = zoom <= 1.0001;
  const zoomInDisabled = zoom >= RADAR_ZOOM_MAX - 0.01;
  const resetDisabled = zoom <= 1.0001 && pan.x === 0 && pan.y === 0;

  const sweepDeg = ((Date.now() % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 360;
  const sweepRad = (sweepDeg * Math.PI) / 180;
  const sweepTf = `rotate(${sweepDeg} ${CX} ${CY})`;
  const { θ1 } = sweepEdgeAngles();
  const sparX2 = CX + R_WAVE_OUT * Math.cos(θ1);
  const sparY2 = CY + R_WAVE_OUT * Math.sin(θ1);

  const latch = plotLatchRef.current;
  const truthIds = new Set<string>();
  const displayPlots: RadarPlotTruth[] = [];
  const nowMs = Date.now();
  for (const p of truthPlots) {
    truthIds.add(p.id);
    let lat = latch.get(p.id);
    if (!lat) {
      lat = { x: p.x, y: p.y, phiRad: p.phiRad, distKm: p.distKm, inRange: p.inRange, commitMs: nowMs };
      latch.set(p.id, lat);
      displayPlots.push({ ...p, paintCommitMs: nowMs });
      continue;
    }
    if (!radarPlotPositionMoved(p, lat)) {
      lat.x = p.x;
      lat.y = p.y;
      lat.phiRad = p.phiRad;
      lat.distKm = p.distKm;
      lat.inRange = p.inRange;
      lat.commitMs = nowMs;
      displayPlots.push({ ...p, paintCommitMs: lat.commitMs });
      continue;
    }
    const glow = blipSweepGlow(lat.phiRad, sweepRad);
    if (glow >= RADAR_PLOT_LATCH_COMMIT_GLOW) {
      displayPlots.push({
        ...p,
        x: lat.x,
        y: lat.y,
        phiRad: lat.phiRad,
        distKm: lat.distKm,
        inRange: lat.inRange,
        paintCommitMs: lat.commitMs
      });
      lat.x = p.x;
      lat.y = p.y;
      lat.phiRad = p.phiRad;
      lat.distKm = p.distKm;
      lat.inRange = p.inRange;
      lat.commitMs = nowMs;
      continue;
    }
    displayPlots.push({
      ...p,
      x: lat.x,
      y: lat.y,
      phiRad: lat.phiRad,
      distKm: lat.distKm,
      inRange: lat.inRange,
      paintCommitMs: lat.commitMs
    });
  }
  for (const id of [...latch.keys()]) {
    if (!truthIds.has(id)) latch.delete(id);
  }

  const trails = trailHistoryRef.current;
  for (const p of displayPlots) {
    let arr = trails.get(p.id);
    if (!arr) {
      arr = [];
      trails.set(p.id, arr);
    }
    const last = arr[arr.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= RADAR_TRAIL_MIN_SAMPLE_DIST) {
      arr.push({ x: p.x, y: p.y, t: nowMs });
    }
    while (arr.length > 0 && nowMs - arr[0].t > RADAR_TRAIL_MAX_AGE_MS) {
      arr.shift();
    }
    while (arr.length > RADAR_TRAIL_MAX_POINTS) {
      arr.shift();
    }
  }
  for (const id of [...trails.keys()]) {
    if (!truthIds.has(id)) trails.delete(id);
  }

  return (
    <div className="tower-radar-scope" role="img" aria-label={`Airfield radar PPI, ${TOWER_RADAR_RANGE_KM} km`}>
      <div className="tower-radar-scope__banner" aria-hidden>
        <span className="tower-radar-scope__banner-title">Airfield radar · PPI</span>
        <span className="tower-radar-scope__banner-range">{TOWER_RADAR_RANGE_KM} km range</span>
      </div>
      <div className="tower-radar-scope__subbar">
        <span className="tower-radar-scope__subbar-origin">{refPt.originLabel}</span>
        <span className="tower-radar-scope__subbar-coords">
          {refPt.lat.toFixed(5)}°, {refPt.lon.toFixed(5)}°
        </span>
        <span className="tower-radar-scope__subbar-spacer" aria-hidden />
        {onPpiOriginIdChange != null && ppiHubOptions.length > 1 ? (
          <label
            className="tower-radar-scope__ppi-hub"
            title="Physical airfield / launch pad this scope is centered on (from your save’s sites). In-game TWR/GND MHz lines are comms presets — they are not map locations."
          >
            <span className="tower-radar-scope__ppi-hub-label">Airfield</span>
            <select
              className="tower-radar-scope__ppi-hub-select"
              value={ppiHubSelectValue}
              onChange={(e) => onPpiOriginIdChange(e.target.value)}
              aria-label="Airfield or launch pad at the center of this PPI"
            >
              {ppiHubOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="tower-radar-scope__subbar-body">{refPt.bodyName}</span>
      </div>
      <div className="tower-radar-scope__crt">
        <div className="tower-radar-scope__crt-scanlines" aria-hidden />
        <div className="tower-radar-scope__zoomport" ref={zoomportRef}>
          <div className="tower-radar-scope__svg-well">
            <svg
              className={
                "tower-radar-scope__svg" + (zoom > 1.0001 ? " tower-radar-scope__svg--pannable" : "")
              }
              viewBox={viewBoxStr}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onSvgPointerDown}
              onPointerMove={onSvgPointerMove}
              onPointerUp={onSvgPointerUp}
              onPointerCancel={onSvgPointerUp}
            >
          <defs>
            <clipPath id={clipId}>
              <circle cx={CX} cy={CY} r={R_MAX} />
            </clipPath>
            <radialGradient id={`${clipId}-face`} cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="#041208" />
              <stop offset="70%" stopColor="#010804" />
              <stop offset="100%" stopColor="#000502" />
            </radialGradient>
            <mask id={`${clipId}-face-sweep-hole`} maskUnits="userSpaceOnUse" x={0} y={0} width={VB} height={VB}>
              <rect x={0} y={0} width={VB} height={VB} fill="#fff" />
              <g transform={sweepTf}>
                <path d={sweepSectorPath()} fill="#000" />
              </g>
            </mask>
          </defs>
          <g pointerEvents="none" className="tower-radar-scope__sweep-wrap" transform={sweepTf}>
            {sweepSlices.map((s, i) => (
              <path key={i} d={s.d} className="tower-radar-scope__sweep-tail" style={{ opacity: s.opacity }} />
            ))}
            <line x1={CX} y1={CY} x2={sparX2} y2={sparY2} className="tower-radar-scope__sweep-spar" />
          </g>
          <path
            d={chassisRingDonutPath(CX, CY, R_MAX, R_CHASSIS_RING_OUT)}
            fillRule="evenodd"
            className="tower-radar-scope__chassis-ring"
            pointerEvents="none"
            aria-hidden
          />
          <circle
            cx={CX}
            cy={CY}
            r={R_MAX}
            fill={`url(#${clipId}-face)`}
            mask={`url(#${clipId}-face-sweep-hole)`}
          />
          <g clipPath={`url(#${clipId})`}>
            {ringFracs.map((f) => (
              <circle
                key={f}
                cx={CX}
                cy={CY}
                r={R_MAX * f}
                fill="none"
                className="tower-radar-scope__ring"
              />
            ))}
            <line x1={CX} y1={CY - R_MAX} x2={CX} y2={CY + R_MAX} className="tower-radar-scope__axis-major" />
            <line x1={CX - R_MAX} y1={CY} x2={CX + R_MAX} y2={CY} className="tower-radar-scope__axis-major" />
            {tickDegs.map((deg) => {
              /* deg = clockwise from north; SVG math angle from +x CCW = -π/2 + deg */
              const rad = -Math.PI / 2 + (deg * Math.PI) / 180;
              const tickLen = deg % 90 === 0 ? 14 : 8;
              return (
                <line
                  key={deg}
                  x1={CX + R_MAX * Math.cos(rad)}
                  y1={CY + R_MAX * Math.sin(rad)}
                  x2={CX + (R_MAX - tickLen) * Math.cos(rad)}
                  y2={CY + (R_MAX - tickLen) * Math.sin(rad)}
                  className={deg % 90 === 0 ? "tower-radar-scope__tick-major" : "tower-radar-scope__tick-minor"}
                />
              );
            })}
            <text
              x={CX + 8}
              y={CY - R_MAX * 0.25 + 4}
              className="tower-radar-scope__ring-label"
              fontSize={RADAR_U_FONT_RING}
            >
              25
            </text>
            <text
              x={CX + 8}
              y={CY - R_MAX * 0.5 + 4}
              className="tower-radar-scope__ring-label"
              fontSize={RADAR_U_FONT_RING}
            >
              50
            </text>
            <text
              x={CX + 8}
              y={CY - R_MAX * 0.75 + 4}
              className="tower-radar-scope__ring-label"
              fontSize={RADAR_U_FONT_RING}
            >
              75
            </text>
            <text
              x={CX + R_MAX - 10}
              y={CY - 14}
              textAnchor="end"
              dominantBaseline="middle"
              className="tower-radar-scope__ring-label tower-radar-scope__ring-label--max"
              fontSize={RADAR_U_FONT_RING_MAX}
            >
              MAX {TOWER_RADAR_RANGE_KM} km
            </text>
            {displayPlots.map((p) => {
              const sweepGlow = blipSweepGlow(p.phiRad, sweepRad);
              const hitIn = sweepGlow > 0.12;
              const hitOor = sweepGlow > 0.1;
              const ageFade = radarBlipAgeFade(p.paintCommitMs ?? nowMs, nowMs);
              const blipR = p.inRange ? RADAR_BLIP_R_IN : RADAR_BLIP_R_OOR;
              const trailRaw = trailHistoryRef.current.get(p.id) ?? [];
              /* Newest sample is the current painted head; draw older samples only. */
              const trailHist = trailRaw.length > 1 ? trailRaw.slice(0, -1) : [];
              return (
              <g
                key={p.id}
                className={"tower-radar-scope__track" + (p.isSelf ? " tower-radar-scope__track--self" : "")}
                style={{ opacity: ageFade }}
              >
                <title>
                  {`${p.callsign} · ${p.distKm < 10 ? p.distKm.toFixed(2) : p.distKm.toFixed(1)} km${
                    !p.inRange ? " (beyond range)" : ""
                  }\n${CALLSIGN_DISPLAY_HELP}`}
                </title>
                {trailHist.map((pt, ti) => (
                  <circle
                    key={`${p.id}-trail-${pt.t}-${ti}`}
                    cx={pt.x}
                    cy={pt.y}
                    r={RADAR_TRAIL_DOT_R}
                    className={
                      p.inRange ? "tower-radar-scope__trail-dot" : "tower-radar-scope__trail-dot--oor"
                    }
                    style={{ opacity: radarTrailDotOpacity(nowMs - pt.t) }}
                  />
                ))}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={blipR}
                  className={
                    (p.inRange ? "tower-radar-scope__blip" : "tower-radar-scope__blip tower-radar-scope__blip--oor") +
                    (p.inRange && hitIn ? " tower-radar-scope__blip--sweep-hit" : "") +
                    (!p.inRange && hitOor ? " tower-radar-scope__blip--oor-sweep-hit" : "")
                  }
                  style={{
                    opacity: p.inRange
                      ? Math.min(1, 0.88 + sweepGlow * 0.12)
                      : Math.min(1, 0.55 + sweepGlow * 0.45)
                  }}
                />
                <text
                  x={p.x + 7}
                  y={p.y + 2.5}
                  className="tower-radar-scope__blip-label"
                  fontSize={RADAR_U_FONT_BLIP}
                >
                  {p.callsign.length > 12 ? `${p.callsign.slice(0, 11)}…` : p.callsign}
                </text>
              </g>
              );
            })}
            <circle cx={CX} cy={CY} r={5} className="tower-radar-scope__tower" />
          </g>
          <circle cx={CX} cy={CY} r={R_MAX + 10} className="tower-radar-scope__bezel-outer" />
          <circle cx={CX} cy={CY} r={R_MAX + 4} className="tower-radar-scope__bezel-inner" />
          <g pointerEvents="none" className="tower-radar-scope__cardinals">
            <text
              x={CX}
              y={CY - R_MAX - 4}
              textAnchor="middle"
              className="tower-radar-scope__cardinal"
              fontSize={RADAR_U_FONT_CARDINAL}
            >
              N
            </text>
            <text
              x={CX + R_MAX + 10}
              y={CY + 5}
              textAnchor="middle"
              className="tower-radar-scope__cardinal"
              fontSize={RADAR_U_FONT_CARDINAL}
            >
              E
            </text>
            <text
              x={CX}
              y={CY + R_MAX + 16}
              textAnchor="middle"
              className="tower-radar-scope__cardinal"
              fontSize={RADAR_U_FONT_CARDINAL}
            >
              S
            </text>
            <text
              x={CX - R_MAX - 10}
              y={CY + 5}
              textAnchor="middle"
              className="tower-radar-scope__cardinal"
              fontSize={RADAR_U_FONT_CARDINAL}
            >
              W
            </text>
          </g>
            </svg>
          </div>
        </div>
        <div className="tower-radar-scope__zoombar tower-radar-scope__zoombar--overlay" role="toolbar" aria-label="Radar zoom">
          <button
            type="button"
            className="tower-radar-scope__zoombtn"
            aria-label="Zoom out"
            disabled={zoomOutDisabled}
            onClick={() => setZoom((z) => Math.max(RADAR_ZOOM_MIN, z / RADAR_ZOOM_BTN))}
          >
            −
          </button>
          <span className="tower-radar-scope__zoompct" aria-live="polite">
            {Math.round(Math.min(RADAR_ZOOM_MAX, Math.max(RADAR_ZOOM_MIN, zoom)) * 100)}%
          </span>
          <button
            type="button"
            className="tower-radar-scope__zoombtn"
            aria-label="Zoom in"
            disabled={zoomInDisabled}
            onClick={() => setZoom((z) => Math.min(RADAR_ZOOM_MAX, z * RADAR_ZOOM_BTN))}
          >
            +
          </button>
          <button
            type="button"
            className="tower-radar-scope__zoombtn tower-radar-scope__zoombtn--text"
            aria-label="Reset zoom and pan"
            disabled={resetDisabled}
            onClick={resetRadarView}
          >
            Reset
          </button>
        </div>
      </div>
      {truthPlots.length === 0 ? (
        <p className="tower-radar-scope__empty">No traffic with position on {refPt.bodyName}.</p>
      ) : null}
    </div>
  );
}
