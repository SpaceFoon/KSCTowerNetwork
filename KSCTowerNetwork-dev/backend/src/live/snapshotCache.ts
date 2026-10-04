import { env } from "../config/env";
import {
  getSession,
  listSessionMessages,
  listSessionsMerged,
  type SessionRecord,
  type TelemetryHealthState,
  type TelemetryStatusEvent
} from "../services/repository";
import {
  HULLCAM_STALE_MS,
  KSC_TOWER_SESSION_PREFIX,
  listActiveSessionIds as listActiveHullCamSessionIds,
  listCameras as listHullCamCameras
} from "../services/hullcamStore";
import { subscribeLiveSnapshotBus } from "./liveSnapshotBus";
import { incLiveMetric, observeLiveMs } from "./metrics";
import { computeApproachSequences, type ApproachSequence } from "../tower/approachQueue";
import { computeSeparationConflicts, type SeparationConflict } from "../tower/separation";
import { snapshotAllOccupancy, type RunwayOccupancyRecord } from "../tower/runwayState";
import type { ViolationEvent } from "../tower/violations";

const ACTIVE_AIRCRAFT_FRESH_MS = 30_000;
const ACTIVE_AIRCRAFT_LIMIT = 64;

const ACTIVE_AIRCRAFT_TTL_MS = 500;
const SESSION_SNAPSHOT_TTL_MS = 500;
const MESSAGES_SNAPSHOT_TTL_MS = 500;
const HULLCAM_META_TTL_MS = 750;
const TOWER_VIEW_STREAMS_TTL_MS = 750;

type CacheEntry<T> = { expiresAtMs: number; value: T };

const activeAircraftBaseCache: { current?: CacheEntry<ActiveAircraftBaseSnapshot> } = {};
const sessionCache = new Map<string, CacheEntry<SessionSnapshot>>();
const sessionMessagesCache = new Map<string, CacheEntry<SessionMessagesSnapshot>>();
const hullcamMetaCache = new Map<string, CacheEntry<HullcamMetaSnapshot>>();
let towerViewStreamsCache: CacheEntry<TowerViewStreamsSnapshot> | undefined;

type ActiveAircraftRow = {
  sessionId: string;
  pilotName: string;
  callsign?: string;
  craftName: string;
  craftType: string;
  craftMapIcon: string;
  ghostCraftKey: string;
  bodyName: string;
  situation?: string;
  lat: number;
  lon: number;
  aslAlt: number;
  radarAlt?: number;
  heading: number;
  surfaceTrack: number;
  pitch: number;
  roll: number;
  surfaceSpeed: number;
  verticalSpeed: number;
  throttle: number;
  gearDown: boolean;
  lights: boolean;
  apoapsis?: number;
  periapsis?: number;
  lastTelemetryAt: string;
  smoothedPositionValid?: boolean;
  smoothedLat?: number;
  smoothedLon?: number;
  smoothedAslAlt?: number;
  distKSC?: number;
  bearingKSC?: number;
  alignErr?: number;
  activeRunway?: string;
  kscAerodrome?: string;
  onApproach?: boolean;
  landing?: boolean;
  flightPhase?: string;
  radioFreqMhz?: number;
  radioPtt?: boolean;
  approachSequence?: ApproachSequence;
  phaseTimeline?: Array<{ code: string; at: string }>;
  recentViolations?: ViolationEvent[];
};

type ActiveAircraftBaseSnapshot = {
  ok: true;
  serverNowMs: number;
  freshMs: number;
  aircraft: Array<ActiveAircraftRow & { pilotUserId: string }>;
  separationConflicts: SeparationConflict[];
  runwayOccupancy: Array<{
    key: string;
    bodyName: string;
    runwayId: string;
    record: RunwayOccupancyRecord;
  }>;
};

export type ActiveAircraftSnapshot = {
  ok: true;
  serverNowMs: number;
  freshMs: number;
  aircraft: ActiveAircraftRow[];
  separationConflicts: SeparationConflict[];
  runwayOccupancy: ActiveAircraftBaseSnapshot["runwayOccupancy"];
};

export type SessionSnapshot = {
  ok: true;
  session: SessionRecord;
  telemetryCadenceSeconds: number;
  telemetryHealth: {
    state: TelemetryHealthState;
    ageSeconds: number | null;
    lastTelemetryAt: string | null;
    reason?: TelemetryStatusEvent;
    staleThresholdSeconds: number;
  };
};

export type SessionMessagesSnapshot = {
  ok: true;
  messages: Array<{
    id: string;
    sessionId: string;
    fromUserId: string;
    body: string;
    createdAt: string;
  }>;
};

export type HullcamMetaSnapshot = {
  ok: true;
  sessionId: string;
  cameras: Array<{ id: number; name: string; updatedAtMs: number; snapshotUrl: string }>;
  serverNowMs: number;
  staleMs: number;
};

export type TowerViewStreamsSnapshot = {
  ok: true;
  serverNowMs: number;
  staleMs: number;
  streams: Array<{
    sessionId: string;
    cameras: Array<{ id: number; name: string; updatedAtMs: number; snapshotUrl: string }>;
  }>;
};

function telemetryAgeSeconds(session: SessionRecord, nowMs: number): number | null {
  if (!session.lastTelemetryAt) return null;
  const t = Date.parse(session.lastTelemetryAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function deriveTelemetryHealth(session: SessionRecord): SessionSnapshot["telemetryHealth"] {
  const nowMs = Date.now();
  const cadence =
    (session.telemetry?.radarAlt ?? Number.POSITIVE_INFINITY) < env.TELEMETRY_CLOSE_AGL_M
      ? env.TELEMETRY_CLOSE_SECONDS
      : env.TELEMETRY_DEFAULT_SECONDS;
  const staleThresholdSeconds = Math.max(5, Math.ceil(cadence * 3));
  const ageSeconds = telemetryAgeSeconds(session, nowMs);
  const lastTelemetryAt = session.lastTelemetryAt ?? null;
  const explicit = session.telemetryStatus;
  if (explicit) {
    const explicitAtMs = Date.parse(explicit.at);
    const explicitAgeSeconds = Number.isFinite(explicitAtMs)
      ? Math.max(0, Math.floor((nowMs - explicitAtMs) / 1000))
      : ageSeconds;
    if (explicitAgeSeconds == null || explicitAgeSeconds <= staleThresholdSeconds) {
      return { state: explicit.state, ageSeconds, lastTelemetryAt, reason: explicit, staleThresholdSeconds };
    }
  }
  if (!session.lastTelemetryAt) {
    return { state: "live", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
  }
  if (ageSeconds != null && ageSeconds > staleThresholdSeconds) {
    return { state: "stale", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
  }
  return { state: "live", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
}

async function buildActiveAircraftBase(): Promise<ActiveAircraftBaseSnapshot> {
  const nowMs = Date.now();
  const all = await listSessionsMerged();
  const sessionById = new Map(all.map((s) => [s.id, s]));
  const raw = all
    .filter((s) => s.status === "active" || s.status === "assigned")
    .filter((s) => !!s.telemetry)
    .filter((s) => !s.telemetry!.ghostOptOut)
    .filter((s) => {
      const t = s.telemetry!;
      return Number.isFinite(t.lat) && Number.isFinite(t.lon) && !(s.telemetryStatus && s.telemetryStatus.state);
    })
    .filter((s) => {
      if (!s.lastTelemetryAt) return false;
      const ageMs = nowMs - Date.parse(s.lastTelemetryAt);
      return Number.isFinite(ageMs) && ageMs <= ACTIVE_AIRCRAFT_FRESH_MS;
    })
    .slice(0, ACTIVE_AIRCRAFT_LIMIT)
    .map((s) => {
      const t = s.telemetry!;
      return {
        sessionId: s.id,
        pilotUserId: s.pilotUserId,
        pilotName: t.pilotName ?? "Unknown",
        callsign: t.callsign ?? s.callsign,
        craftName: t.craftName ?? "Aircraft",
        craftType: t.craftType ?? "Plane",
        craftMapIcon: t.craftMapIcon ?? "plane",
        ghostCraftKey: t.ghostCraftKey ?? "",
        bodyName: t.bodyName ?? "Kerbin",
        situation: t.situation,
        lat: t.lat!,
        lon: t.lon!,
        aslAlt: t.aslAlt ?? 0,
        radarAlt: t.radarAlt,
        heading: t.heading ?? 0,
        surfaceTrack: Number.isFinite(t.surfaceTrack) ? t.surfaceTrack! : (t.heading ?? 0),
        pitch: t.pitch ?? 0,
        roll: t.roll ?? 0,
        surfaceSpeed: t.surfaceSpeed ?? 0,
        verticalSpeed: t.verticalSpeed ?? 0,
        throttle: t.throttle ?? 0,
        gearDown: t.gearDown ?? false,
        lights: t.lights ?? false,
        apoapsis: t.apoapsis,
        periapsis: t.periapsis,
        lastTelemetryAt: s.lastTelemetryAt!,
        smoothedPositionValid: t.smoothedPositionValid,
        smoothedLat: t.smoothedLat,
        smoothedLon: t.smoothedLon,
        smoothedAslAlt: t.smoothedAslAlt,
        distKSC: t.distKSC,
        bearingKSC: t.bearingKSC,
        alignErr: t.alignErr,
        activeRunway: t.activeRunway,
        kscAerodrome: t.kscAerodrome,
        onApproach: t.onApproach,
        landing: t.landing,
        flightPhase: t.flightPhase,
        radioFreqMhz: t.radioFreqMhz,
        radioPtt: t.radioPtt
      };
    });
  const approachMap = computeApproachSequences(
    raw.map((a) => ({
      sessionId: a.sessionId,
      bodyName: a.bodyName,
      activeRunway: a.activeRunway,
      onApproach: a.onApproach,
      distKSC: a.distKSC,
      alignErr: a.alignErr,
      radarAlt: a.radarAlt,
      aslAlt: a.aslAlt,
      lat: a.lat,
      lon: a.lon
    }))
  );
  const aircraft = raw.map((a) => {
    const sess = sessionById.get(a.sessionId);
    return {
      ...a,
      approachSequence: approachMap.get(a.sessionId),
      phaseTimeline: sess?.phaseTimeline?.slice(-4),
      recentViolations: sess?.recentViolations?.slice(-2)
    };
  });
  const separationConflicts = computeSeparationConflicts(
    aircraft.map((a) => ({
      sessionId: a.sessionId,
      bodyName: a.bodyName,
      lat: a.lat,
      lon: a.lon,
      radarAlt: a.radarAlt,
      aslAlt: a.aslAlt,
      callsign: a.callsign
    }))
  );
  const runwayOccupancy = snapshotAllOccupancy();
  return { ok: true, serverNowMs: nowMs, freshMs: ACTIVE_AIRCRAFT_FRESH_MS, aircraft, separationConflicts, runwayOccupancy };
}

export async function getActiveAircraftSnapshot(selfUserId: string): Promise<ActiveAircraftSnapshot> {
  const now = Date.now();
  let base = activeAircraftBaseCache.current?.value;
  if (!base || (activeAircraftBaseCache.current?.expiresAtMs ?? 0) <= now) {
    const started = Date.now();
    base = await buildActiveAircraftBase();
    activeAircraftBaseCache.current = { value: base, expiresAtMs: now + ACTIVE_AIRCRAFT_TTL_MS };
    incLiveMetric("snapshot_builds");
    observeLiveMs("snapshot_encode_ms", Date.now() - started);
  }
  return {
    ok: true,
    serverNowMs: base.serverNowMs,
    freshMs: base.freshMs,
    aircraft: base.aircraft.filter((a) => a.pilotUserId !== selfUserId).map(({ pilotUserId: _ignore, ...rest }) => rest),
    separationConflicts: base.separationConflicts,
    runwayOccupancy: base.runwayOccupancy
  };
}

export async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  const now = Date.now();
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expiresAtMs > now) return cached.value;
  const started = Date.now();
  const session = await getSession(sessionId);
  if (!session) return null;
  const payload: SessionSnapshot = {
    ok: true,
    session,
    telemetryCadenceSeconds:
      (session.telemetry?.radarAlt ?? Number.POSITIVE_INFINITY) < env.TELEMETRY_CLOSE_AGL_M
        ? env.TELEMETRY_CLOSE_SECONDS
        : env.TELEMETRY_DEFAULT_SECONDS,
    telemetryHealth: deriveTelemetryHealth(session)
  };
  sessionCache.set(sessionId, { value: payload, expiresAtMs: now + SESSION_SNAPSHOT_TTL_MS });
  incLiveMetric("snapshot_builds");
  observeLiveMs("snapshot_encode_ms", Date.now() - started);
  return payload;
}

export async function getSessionMessagesSnapshot(sessionId: string): Promise<SessionMessagesSnapshot> {
  const now = Date.now();
  const cached = sessionMessagesCache.get(sessionId);
  if (cached && cached.expiresAtMs > now) return cached.value;
  const started = Date.now();
  const messages = await listSessionMessages(sessionId);
  const payload: SessionMessagesSnapshot = { ok: true, messages };
  sessionMessagesCache.set(sessionId, { value: payload, expiresAtMs: now + MESSAGES_SNAPSHOT_TTL_MS });
  incLiveMetric("snapshot_builds");
  observeLiveMs("snapshot_encode_ms", Date.now() - started);
  return payload;
}

export function getHullcamMetaSnapshot(sessionId: string): HullcamMetaSnapshot {
  const now = Date.now();
  const cached = hullcamMetaCache.get(sessionId);
  if (cached && cached.expiresAtMs > now) return cached.value;
  const started = Date.now();
  const cameras = listHullCamCameras(sessionId).map((c) => ({
    id: c.id,
    name: c.name,
    updatedAtMs: c.updatedAtMs,
    snapshotUrl: `/v1/hullcam/${encodeURIComponent(sessionId)}/${c.id}/snapshot.jpg`
  }));
  const payload: HullcamMetaSnapshot = {
    ok: true,
    sessionId,
    cameras,
    serverNowMs: now,
    staleMs: HULLCAM_STALE_MS
  };
  hullcamMetaCache.set(sessionId, { value: payload, expiresAtMs: now + HULLCAM_META_TTL_MS });
  incLiveMetric("snapshot_builds");
  observeLiveMs("snapshot_encode_ms", Date.now() - started);
  return payload;
}

export function getTowerViewStreamsSnapshot(): TowerViewStreamsSnapshot {
  const now = Date.now();
  if (towerViewStreamsCache && towerViewStreamsCache.expiresAtMs > now) {
    return towerViewStreamsCache.value;
  }
  const started = Date.now();
  const sessionIds = listActiveHullCamSessionIds(KSC_TOWER_SESSION_PREFIX);
  const streams = sessionIds.map((sessionId) => {
    const cameras = listHullCamCameras(sessionId).map((c) => ({
      id: c.id,
      name: c.name,
      updatedAtMs: c.updatedAtMs,
      snapshotUrl: `/v1/hullcam/${encodeURIComponent(sessionId)}/${c.id}/snapshot.jpg`
    }));
    return { sessionId, cameras };
  });
  const payload: TowerViewStreamsSnapshot = {
    ok: true,
    serverNowMs: now,
    staleMs: HULLCAM_STALE_MS,
    streams
  };
  towerViewStreamsCache = { value: payload, expiresAtMs: now + TOWER_VIEW_STREAMS_TTL_MS };
  incLiveMetric("snapshot_builds");
  observeLiveMs("snapshot_encode_ms", Date.now() - started);
  return payload;
}

export function invalidateActiveAircraftSnapshot(): void {
  activeAircraftBaseCache.current = undefined;
}

export function invalidateSessionSnapshot(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export function invalidateSessionMessagesSnapshot(sessionId: string): void {
  sessionMessagesCache.delete(sessionId);
}

export function invalidateHullcamMetaSnapshot(sessionId: string): void {
  hullcamMetaCache.delete(sessionId);
  towerViewStreamsCache = undefined;
}

subscribeLiveSnapshotBus((event) => {
  if (event.topic === "session-messages") {
    invalidateSessionMessagesSnapshot(event.sessionId);
  }
});
