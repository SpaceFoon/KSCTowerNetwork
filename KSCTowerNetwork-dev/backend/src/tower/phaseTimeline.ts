export type TowerPhase = "OUT" | "OFF" | "APP" | "ON" | "IN";

/** Narrow shape so this module does not import `repository` (cycles). */
export type PhaseTelemetrySlice = {
  bodyName?: string;
  distKSC?: number;
  onApproach?: boolean;
  situation?: string;
  flightPhase?: string;
  radarAlt?: number;
};

function situationGrounded(situation: string | undefined): boolean {
  if (!situation) return false;
  const u = situation.toUpperCase();
  return u.includes("LANDED") || u.includes("SPLASHED") || u.includes("PRELANDED");
}

/** Single-tick canonical phase from telemetry (dwell applied by caller). */
export function deriveCanonicalPhase(t: PhaseTelemetrySlice): TowerPhase {
  const body = t.bodyName ?? "";
  const dist = t.distKSC;
  const onApp = t.onApproach === true;
  const grounded = situationGrounded(t.situation);
  const fp = (t.flightPhase ?? "").toUpperCase();

  if (grounded) {
    if (fp.includes("TAXI") && (t.radarAlt ?? 0) > 20) return "IN";
    return "ON";
  }
  if (onApp) return "APP";
  if (body === "Kerbin" && typeof dist === "number" && Number.isFinite(dist)) {
    if (dist >= 150_000) return "OUT";
    return "OFF";
  }
  if (!grounded) return "OFF";
  return "OUT";
}

type PhaseMachine = {
  committed: TowerPhase;
  candidate: TowerPhase;
  candidateSinceMs: number;
};

const machines = new Map<string, PhaseMachine>();

const DWELL_MS = 4000;

/** Returns new timeline entries to append (0 or 1). */
export function phaseTimelineTick(
  sessionId: string,
  sample: PhaseTelemetrySlice,
  nowMs: number
): { code: TowerPhase; at: string } | null {
  const want = deriveCanonicalPhase(sample);
  let m = machines.get(sessionId);
  if (!m) {
    m = { committed: want, candidate: want, candidateSinceMs: nowMs };
    machines.set(sessionId, m);
    return { code: want, at: new Date(nowMs).toISOString() };
  }
  if (want !== m.candidate) {
    m.candidate = want;
    m.candidateSinceMs = nowMs;
    return null;
  }
  if (want === m.committed) return null;
  if (nowMs - m.candidateSinceMs < DWELL_MS) return null;
  m.committed = want;
  return { code: want, at: new Date(nowMs).toISOString() };
}

export function resetPhaseMachine(sessionId: string): void {
  machines.delete(sessionId);
}
