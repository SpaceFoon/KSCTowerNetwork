/**
 * Client-side mirror of the backend scoring detectors.
 *
 * NOTE: This module is a literal port of `backend/src/services/scoring.ts`. It exists so the
 * pilot's browser can flash the achievement immediately (`POST /preview-event`) while the
 * server's canonical detector catches up on the next telemetry cycle. The backend `auto`
 * row will overwrite the `client_preview` row via the same `dedupeBucket`, so a tiny rule
 * drift between the two files is *visible* (a flashed achievement disappears) but never
 * persists. If you change a rule here, mirror it in the backend file (and vice versa).
 *
 * Backend module: GameData/KSCTowerNetwork/backend/src/services/scoring.ts
 */

export interface PreviewSample {
  verticalSpeed?: number;
  surfaceSpeed?: number;
  radarAlt?: number;
  aslAlt?: number;
  throttle?: number;
  gearDown?: boolean;
  roll?: number;
  gLoad?: number;
  lat?: number;
  lon?: number;
  /** Mirrors backend `TelemetrySample.flightPhase` for departure-aware detectors. */
  flightPhase?: string;
}

export interface PreviewEvent {
  kind: string;
  points: number;
  label: string;
  /** Used as part of the dedupeBucket sent to /preview-event so the auto row collides cleanly. */
  bucketSec: number;
}

const KSC_LAT = -0.0972;
const KSC_LON = -74.5577;

interface PreviewState {
  rollSamples: number[];
  lastFiredAt: Map<string, number>;
}

const STATE = new Map<string, PreviewState>();
const ROLL_WINDOW = 10;

function getState(sessionId: string): PreviewState {
  let s = STATE.get(sessionId);
  if (!s) {
    s = { rollSamples: [], lastFiredAt: new Map() };
    STATE.set(sessionId, s);
  }
  return s;
}

export function clearPreviewState(sessionId: string): void {
  STATE.delete(sessionId);
}

function cooledDown(state: PreviewState, kind: string, nowSec: number, minGapSec: number): boolean {
  const last = state.lastFiredAt.get(kind);
  return last == null ? true : nowSec - last >= minGapSec;
}

function note(state: PreviewState, kind: string, nowSec: number): void {
  state.lastFiredAt.set(kind, nowSec);
}

function distKmFromKsc(lat?: number, lon?: number): number {
  if (lat == null || lon == null) return Number.POSITIVE_INFINITY;
  const R = 600;
  const dLat = ((lat - KSC_LAT) * Math.PI) / 180;
  const dLon = ((lon - KSC_LON) * Math.PI) / 180;
  const x = dLon * Math.cos((KSC_LAT * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

function suppressLowPassForFlightPhase(flightPhase: string | undefined): boolean {
  const fp = (flightPhase ?? "").toUpperCase();
  return fp.includes("TAXI") || fp.includes("TAKEOFF") || fp.includes("CLIMB");
}

function rollWrap(samples: number[]): number {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    let d = (samples[i] ?? 0) - (samples[i - 1] ?? 0);
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    total += Math.abs(d);
  }
  return total;
}

/**
 * Mirrors `detectFromTelemetry` in the backend. Returns events the UI may flash immediately;
 * caller should still POST them to /preview-event so they show up on the controller's scorecard.
 */
export function detectFromTelemetryClient(
  prev: PreviewSample | undefined,
  curr: PreviewSample,
  sessionId: string,
  sessionEpochSec: number
): PreviewEvent[] {
  const state = getState(sessionId);
  const out: PreviewEvent[] = [];
  const bucket = (gap: number): number => Math.floor(sessionEpochSec / gap) * gap;

  const prevVS = prev?.verticalSpeed ?? 0;
  const currVS = curr.verticalSpeed ?? 0;
  const radarAlt = curr.radarAlt ?? Number.POSITIVE_INFINITY;
  const prevSurf = prev?.surfaceSpeed ?? 0;
  const currSurf = curr.surfaceSpeed ?? 0;
  const aslAlt = curr.aslAlt ?? 0;
  const prevThrottle = prev?.throttle ?? 0;
  const currThrottle = curr.throttle ?? 0;

  if (
    prevVS <= 0 &&
    currVS > 5 &&
    radarAlt < 30 &&
    cooledDown(state, "liftoff", sessionEpochSec, 60)
  ) {
    out.push({ kind: "liftoff", points: 0, label: "Liftoff", bucketSec: bucket(2) });
    note(state, "liftoff", sessionEpochSec);
  }

  if (
    prevSurf < 343 &&
    currSurf >= 343 &&
    aslAlt < 30000 &&
    cooledDown(state, "maxq", sessionEpochSec, 60)
  ) {
    out.push({ kind: "maxq", points: 0, label: "Max Q (transonic)", bucketSec: bucket(2) });
    note(state, "maxq", sessionEpochSec);
  }

  if (
    prevThrottle > 0.7 &&
    currThrottle < 0.05 &&
    aslAlt > 30000 &&
    cooledDown(state, "meco", sessionEpochSec, 30)
  ) {
    out.push({ kind: "meco", points: 0, label: "Main engine cutoff", bucketSec: bucket(2) });
    note(state, "meco", sessionEpochSec);
  }

  const isTouchdown =
    radarAlt < 1 && (prev?.verticalSpeed ?? 0) < -0.2 && cooledDown(state, "touchdown", sessionEpochSec, 30);
  if (isTouchdown) {
    out.push({ kind: "touchdown", points: 0, label: "Touchdown", bucketSec: bucket(2) });
    note(state, "touchdown", sessionEpochSec);
    if (currVS > -0.5) {
      out.push({ kind: "greaser", points: 10, label: "Greaser landing", bucketSec: bucket(2) });
      note(state, "greaser", sessionEpochSec);
    }
    if (curr.gearDown === false) {
      out.push({ kind: "gear_up_landing", points: -15, label: "Gear-up landing", bucketSec: bucket(2) });
      note(state, "gear_up_landing", sessionEpochSec);
    }
  }

  if (
    aslAlt < 100 &&
    currSurf > 100 &&
    distKmFromKsc(curr.lat, curr.lon) < 5 &&
    !suppressLowPassForFlightPhase(curr.flightPhase) &&
    cooledDown(state, "low_pass", sessionEpochSec, 90)
  ) {
    out.push({ kind: "low_pass", points: 5, label: "Low pass over KSC", bucketSec: bucket(2) });
    note(state, "low_pass", sessionEpochSec);
  }

  if (curr.roll != null) {
    state.rollSamples.push(curr.roll);
    if (state.rollSamples.length > ROLL_WINDOW) state.rollSamples.shift();
  }
  if (rollWrap(state.rollSamples) >= 330 && cooledDown(state, "barrel_roll", sessionEpochSec, 30)) {
    out.push({ kind: "barrel_roll", points: 10, label: "Barrel roll", bucketSec: bucket(2) });
    note(state, "barrel_roll", sessionEpochSec);
  }

  const gLoad = Math.abs(curr.gLoad ?? 0);
  if (gLoad > 9 && cooledDown(state, "broke_g", sessionEpochSec, 30)) {
    out.push({ kind: "broke_g", points: -10, label: "Over-g (>9)", bucketSec: bucket(2) });
    note(state, "broke_g", sessionEpochSec);
  }

  if (
    prevThrottle > 0.5 &&
    currThrottle < 0.05 &&
    radarAlt < 500 &&
    cooledDown(state, "flameout_low", sessionEpochSec, 20)
  ) {
    out.push({
      kind: "flameout_low",
      points: -5,
      label: "Engine flameout below 500 m",
      bucketSec: bucket(2)
    });
    note(state, "flameout_low", sessionEpochSec);
  }

  return out;
}
