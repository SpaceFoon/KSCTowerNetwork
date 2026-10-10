import type { Telemetry, TowerAircraftTrack } from "../components/KerbinTowerMap";

/** Wire shape of `/v1/tower/active-aircraft` rows (see `backend/src/live/snapshotCache.ts`). */
export type ActiveAircraftWire = {
  sessionId: string;
  pilotName?: string;
  callsign?: string;
  craftName?: string;
  craftType?: string;
  craftMapIcon?: string;
  bodyName?: string;
  situation?: string;
  lat?: number;
  lon?: number;
  aslAlt?: number;
  radarAlt?: number;
  heading?: number;
  surfaceSpeed?: number;
  lastTelemetryAt?: string;
  telemetryHealthState?: string;
  targetRunway?: string;
  verticalSpeed?: number;
  apoapsis?: number;
  periapsis?: number;
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
  approachSequence?: { index: number; of: number; gapKmBehindLeader?: number };
  phaseTimeline?: Array<{ code: string; at: string }>;
  recentViolations?: Array<{ id: string; kind: string; at: string; detail?: string }>;
};

function mapTelemetryForPlot(t: Telemetry): Telemetry {
  if (!t.smoothedPositionValid || t.smoothedLat == null || t.smoothedLon == null) {
    return t;
  }
  return {
    ...t,
    lat: t.smoothedLat,
    lon: t.smoothedLon,
    aslAlt: t.smoothedAslAlt ?? t.aslAlt
  };
}

export function activeRowToTelemetry(a: ActiveAircraftWire): Telemetry {
  const cmi = a.craftMapIcon;
  const useSmoothed = a.smoothedPositionValid && a.smoothedLat != null && a.smoothedLon != null;
  return {
    craftName: a.craftName,
    pilotName: a.pilotName,
    callsign: a.callsign,
    craftType: a.craftType,
    craftMapIcon: cmi === "plane" || cmi === "rover" || cmi === "rocket" ? cmi : undefined,
    bodyName: a.bodyName,
    situation: a.situation,
    lat: useSmoothed ? a.smoothedLat : a.lat,
    lon: useSmoothed ? a.smoothedLon : a.lon,
    aslAlt: useSmoothed && a.smoothedAslAlt != null ? a.smoothedAslAlt : a.aslAlt,
    radarAlt: a.radarAlt,
    heading: a.heading,
    surfaceSpeed: a.surfaceSpeed,
    sampleUnixMs: a.telemetryHealthState && a.telemetryHealthState !== "live" ? NaN : a.lastTelemetryAt ? Date.parse(a.lastTelemetryAt) : undefined,
    targetRunway: a.targetRunway,
    verticalSpeed: a.verticalSpeed,
    apoapsis: a.apoapsis,
    periapsis: a.periapsis,
    smoothedPositionValid: a.smoothedPositionValid,
    smoothedLat: a.smoothedLat,
    smoothedLon: a.smoothedLon,
    smoothedAslAlt: a.smoothedAslAlt,
    distKSC: a.distKSC,
    bearingKSC: a.bearingKSC,
    alignErr: a.alignErr,
    activeRunway: a.activeRunway,
    kscAerodrome: a.kscAerodrome,
    onApproach: a.onApproach,
    landing: a.landing,
    flightPhase: a.flightPhase,
    radioFreqMhz: a.radioFreqMhz,
    radioPtt: a.radioPtt
  };
}

function resolvedBodyForHome(wire: string | undefined | null, homeBodyName: string): string {
  const w = typeof wire === "string" ? wire.trim() : "";
  const h = homeBodyName.trim();
  return w.length > 0 ? w : h;
}

/**
 * Safe trim for session/telemetry callsign fields: JSON may ship non-strings at runtime;
 * calling `.trim()` on a number throws and can blank the whole radar layer.
 */
export function trimmedPilotCallsign(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const t = String(v).trim();
    return t.length > 0 ? t : undefined;
  }
  const t = String(v).trim();
  return t.length > 0 ? t : undefined;
}

export function buildTowerAircraftTracks(input: {
  homeBodyName: string;
  sessionId: string;
  telemetry: Telemetry | null;
  selfCallsign?: string | null | undefined;
  active: readonly ActiveAircraftWire[];
}): TowerAircraftTrack[] {
  const homeLc = input.homeBodyName.trim().toLowerCase();
  const selfId = input.sessionId.trim() || "self";
  const out: TowerAircraftTrack[] = [];

  const tRaw = input.telemetry;
  const t = tRaw ? mapTelemetryForPlot(tRaw) : null;
  const selfBodyLc = resolvedBodyForHome(t?.bodyName, input.homeBodyName).toLowerCase();
  if (
    t?.lat != null &&
    t.lon != null &&
    Number.isFinite(t.lat) &&
    Number.isFinite(t.lon) &&
    selfBodyLc === homeLc
  ) {
    /** Session pilot callsign before telemetry: telemetry may echo radio facility (e.g. KSC-TWR). */
    const label =
      trimmedPilotCallsign(input.selfCallsign) ??
      trimmedPilotCallsign(t.callsign) ??
      trimmedPilotCallsign(t.craftName) ??
      trimmedPilotCallsign(t.pilotName) ??
      "UNKNOWN";
    out.push({
      id: selfId,
      label: label.slice(0, 64),
      telemetry: { ...t, bodyName: t.bodyName ?? input.homeBodyName },
      isSelf: true
    });
  }

  for (const a of input.active) {
    if (a.sessionId === selfId) continue;
    const rowBodyLc = resolvedBodyForHome(a.bodyName, input.homeBodyName).toLowerCase();
    if (rowBodyLc !== homeLc) continue;
    const tel = activeRowToTelemetry(a);
    if (tel.lat == null || tel.lon == null || !Number.isFinite(tel.lat) || !Number.isFinite(tel.lon))
      continue;
    const label = (a.callsign ?? tel.callsign ?? a.craftName ?? a.pilotName ?? "UNKNOWN").slice(0, 64);
    const plotted = mapTelemetryForPlot(tel);
    out.push({
      id: a.sessionId,
      label,
      telemetry: { ...plotted, bodyName: plotted.bodyName ?? input.homeBodyName },
      isSelf: false
    });
  }

  return out;
}
