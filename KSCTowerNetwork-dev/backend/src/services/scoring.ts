/**
 * Pure scoring detectors for ATC roleplay events.
 *
 * NOTE: kept side-effect free so the same logic can be ported verbatim to
 * `web/src/scoring/rules.ts` for client-side preview. If you change a rule here,
 * mirror it there. Backend is canonical — frontend rows are upserted with the
 * same dedupe bucket so the `auto` row wins on race.
 */
import type { TelemetrySample } from "./repository";

export interface DetectorEvent {
  /** Stable kind identifier; also used as the dedupe bucket prefix. */
  kind: string;
  /** Signed score delta (positive = achievement, negative = penalty, 0 = announce-only). */
  points: number;
  /** Human-readable short label (≤ 120 chars) for the chat feed and scorecard row. */
  label: string;
  /** Time bucket (seconds since session epoch) used to dedupe `auto` vs `client_preview`. */
  bucketSec: number;
}

interface SlidingState {
  samples: TelemetrySample[];
  lastScoredAt: Map<string, number>;
}

const STATE = new Map<string, SlidingState>();
const WINDOW = 10;

function getState(sessionId: string): SlidingState {
  let s = STATE.get(sessionId);
  if (!s) {
    s = { samples: [], lastScoredAt: new Map() };
    STATE.set(sessionId, s);
  }
  return s;
}

export function clearScoringState(sessionId: string): void {
  STATE.delete(sessionId);
}

function pushSample(state: SlidingState, sample: TelemetrySample): void {
  state.samples.push(sample);
  if (state.samples.length > WINDOW) state.samples.shift();
}

function cooledDown(state: SlidingState, kind: string, nowSec: number, minGapSec: number): boolean {
  const last = state.lastScoredAt.get(kind);
  if (last == null) return true;
  return nowSec - last >= minGapSec;
}

function note(state: SlidingState, kind: string, nowSec: number): void {
  state.lastScoredAt.set(kind, nowSec);
}

// KSC reference for low-pass detection. Real game value; close enough for fly-by purposes.
const KSC_LAT = -0.0972;
const KSC_LON = -74.5577;

function distKmFromKsc(lat?: number, lon?: number): number {
  if (lat == null || lon == null) return Number.POSITIVE_INFINITY;
  // Equirectangular approximation; ~6 km/deg around the equator on Kerbin (R=600km).
  const R = 600;
  const dLat = ((lat - KSC_LAT) * Math.PI) / 180;
  const dLon = ((lon - KSC_LON) * Math.PI) / 180;
  const x = dLon * Math.cos((KSC_LAT * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/** KSC "low pass" stunt should not fire during departure-ish plugin phases (see TowerTelemetryPublisher). */
function suppressLowPassForFlightPhase(flightPhase: string | undefined): boolean {
  const fp = (flightPhase ?? "").toUpperCase();
  return fp.includes("TAXI") || fp.includes("TAKEOFF") || fp.includes("CLIMB");
}

/**
 * Run all detectors against a single fresh telemetry sample. `prev` is whatever the caller
 * still has (before `setTelemetry` is called); `sessionEpochSec` is `Math.floor(Date.now()/1000)`.
 *
 * Returns events in announce order. Caller is responsible for awarding + chat broadcast.
 */
export function detectFromTelemetry(
  prev: TelemetrySample | undefined,
  curr: TelemetrySample,
  sessionId: string,
  sessionEpochSec: number
): DetectorEvent[] {
  const state = getState(sessionId);
  const out: DetectorEvent[] = [];
  const bucket = (gapSec: number): number => Math.floor(sessionEpochSec / gapSec) * gapSec;

  // liftoff: vertical speed crosses 5 m/s upward near the ground.
  const prevVS = prev?.verticalSpeed ?? 0;
  const currVS = curr.verticalSpeed ?? 0;
  const radarAlt = curr.radarAlt ?? Number.POSITIVE_INFINITY;
  if (
    prevVS <= 0 &&
    currVS > 5 &&
    radarAlt < 30 &&
    cooledDown(state, "liftoff", sessionEpochSec, 60)
  ) {
    out.push({ kind: "liftoff", points: 0, label: "Liftoff", bucketSec: bucket(2) });
    note(state, "liftoff", sessionEpochSec);
  }

  // maxq: cross Mach 1 (~343 m/s) below 30km. Announce-only. 60s cooldown.
  const prevSurf = prev?.surfaceSpeed ?? 0;
  const currSurf = curr.surfaceSpeed ?? 0;
  const aslAlt = curr.aslAlt ?? 0;
  if (
    prevSurf < 343 &&
    currSurf >= 343 &&
    aslAlt < 30000 &&
    cooledDown(state, "maxq", sessionEpochSec, 60)
  ) {
    out.push({ kind: "maxq", points: 0, label: "Max Q (transonic)", bucketSec: bucket(2) });
    note(state, "maxq", sessionEpochSec);
  }

  // meco: throttle collapses above 30km (rocket flight only).
  const prevThrottle = prev?.throttle ?? 0;
  const currThrottle = curr.throttle ?? 0;
  if (
    prevThrottle > 0.7 &&
    currThrottle < 0.05 &&
    aslAlt > 30000 &&
    cooledDown(state, "meco", sessionEpochSec, 30)
  ) {
    out.push({ kind: "meco", points: 0, label: "Main engine cutoff", bucketSec: bucket(2) });
    note(state, "meco", sessionEpochSec);
  }

  // touchdown: ground contact; we score this *and* the achievement/penalty variants on the
  // same edge so the "greaser" / "gear_up_landing" rows attach to the same dedupe window.
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
      out.push({
        kind: "gear_up_landing",
        points: -15,
        label: "Gear-up landing",
        bucketSec: bucket(2)
      });
      note(state, "gear_up_landing", sessionEpochSec);
    }
  }

  // low_pass: fast and low within 5 km of KSC. 90s cooldown so a slow taxi doesn't spam.
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

  // barrel_roll: roll wraps ≥330° across the recent sliding window.
  pushSample(state, curr);
  const rollDelta = computeRollWrap(state.samples);
  if (rollDelta >= 330 && cooledDown(state, "barrel_roll", sessionEpochSec, 30)) {
    out.push({ kind: "barrel_roll", points: 10, label: "Barrel roll", bucketSec: bucket(2) });
    note(state, "barrel_roll", sessionEpochSec);
  }

  // broke_g: |g-load| spikes above 9. Debounced 30s so a single yank isn't double-counted.
  const gLoad = Math.abs(curr.gLoad ?? 0);
  if (gLoad > 9 && cooledDown(state, "broke_g", sessionEpochSec, 30)) {
    out.push({ kind: "broke_g", points: -10, label: "Over-g (>9)", bucketSec: bucket(2) });
    note(state, "broke_g", sessionEpochSec);
  }

  // flameout_low: throttle was high, now collapsed, and we're low — likely flameout, not deliberate cut.
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

/**
 * Sum the absolute roll change across the sliding window, treating wrap-around (e.g. 170 → -170)
 * as a small step rather than a 340° jump. This way a clean barrel roll registers as ~360° while
 * a stationary plane sitting at roll=180 doesn't trigger anything.
 */
function computeRollWrap(samples: TelemetrySample[]): number {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]?.roll;
    const b = samples[i]?.roll;
    if (a == null || b == null) continue;
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    total += Math.abs(d);
  }
  return total;
}
