/** Shared touchdown / ground detection for tower hooks. */

export function situationGrounded(situation: string | undefined): boolean {
  if (!situation) return false;
  const u = situation.toUpperCase();
  return u.includes("LANDED") || u.includes("SPLASHED") || u.includes("PRELANDED");
}

export type EdgeTelemetry = {
  situation?: string;
  onApproach?: boolean;
  distKSC?: number;
  verticalSpeed?: number;
  aslAlt?: number;
  radarAlt?: number;
  /** KSP plugin `flightPhase` (e.g. TAKEOFF, APPROACH, LANDING, CRUISE). */
  flightPhase?: string;
  /** Plugin: aligned with runway, descending, near field — too loose alone for go-around. */
  landing?: boolean;
};

/** True when the publisher marks an actual arrival segment (Kerbin ILS context). */
export function publisherLandingApproachIntent(t: EdgeTelemetry | undefined): boolean {
  if (!t) return false;
  if (t.landing === true) return true;
  const fp = (t.flightPhase ?? "").toUpperCase();
  return fp.includes("APPROACH") || fp.includes("LANDING");
}

/**
 * Airborne sample is clearly in departure / initial climb — suppress arrival touchdown hooks
 * (pad hops during takeoff) while still allowing e.g. Mun touchdowns (usually CRUISE/PRELAUNCH).
 */
export function publisherDepartureClimbPhase(t: EdgeTelemetry | undefined): boolean {
  if (!t) return false;
  const fp = (t.flightPhase ?? "").toUpperCase();
  return fp.includes("TAKEOFF") || fp.includes("CLIMB");
}

export function isTouchdownTransition(prev: EdgeTelemetry | undefined, curr: EdgeTelemetry): boolean {
  if (!prev) return false;
  const wasAir = !situationGrounded(prev.situation);
  const nowG = situationGrounded(curr.situation);
  return wasAir && nowG;
}

/**
 * Air → ground transition that should drive tower landing messages / violations.
 * Excludes departure hops (previous tick still tagged TAKEOFF/CLIMB by the plugin).
 */
export function isArrivalTouchdown(prev: EdgeTelemetry | undefined, curr: EdgeTelemetry): boolean {
  if (!isTouchdownTransition(prev, curr)) return false;
  if (publisherDepartureClimbPhase(prev)) return false;
  return true;
}

export function missedApproachCandidate(prev: EdgeTelemetry, curr: EdgeTelemetry): boolean {
  if (!curr.onApproach) return false;
  if (!publisherLandingApproachIntent(prev) && !publisherLandingApproachIntent(curr)) return false;
  const dist = curr.distKSC ?? Number.POSITIVE_INFINITY;
  if (dist >= 3000) return false;
  const vs = curr.verticalSpeed ?? 0;
  const prevAlt = prev.aslAlt ?? prev.radarAlt ?? 0;
  const curAlt = curr.aslAlt ?? curr.radarAlt ?? 0;
  return vs > 2 || curAlt > prevAlt + 8;
}
