import { randomUUID } from "node:crypto";

export type ViolationKind =
  | "LANDING_NO_CLEARANCE"
  | "RWY_INCURSION"
  | "LOSS_OF_SEPARATION"
  | "WRONG_RUNWAY";

export type ViolationEvent = {
  id: string;
  sessionId: string;
  kind: ViolationKind;
  at: string;
  detail?: string;
};

export function violationDisplayLine(kind: ViolationKind): string {
  switch (kind) {
    case "LANDING_NO_CLEARANCE":
      return "VIOLATION: LANDING WITHOUT CLEARANCE";
    case "RWY_INCURSION":
      return "VIOLATION: RWY INCURSION";
    case "LOSS_OF_SEPARATION":
      return "VIOLATION: LOSS OF SEPARATION";
    case "WRONG_RUNWAY":
      return "VIOLATION: WRONG RUNWAY";
    default:
      return "VIOLATION";
  }
}

const DEDUPE_MS = 45_000;
const lastBySession = new Map<string, Map<ViolationKind, number>>();

export function shouldEmitViolation(sessionId: string, kind: ViolationKind, nowMs: number): boolean {
  let m = lastBySession.get(sessionId);
  if (!m) {
    m = new Map();
    lastBySession.set(sessionId, m);
  }
  const prev = m.get(kind);
  if (prev != null && nowMs - prev < DEDUPE_MS) return false;
  m.set(kind, nowMs);
  return true;
}

export function pushViolationEvent(
  sessionId: string,
  kind: ViolationKind,
  nowMs: number,
  detail?: string
): ViolationEvent | null {
  if (!shouldEmitViolation(sessionId, kind, nowMs)) return null;
  return {
    id: randomUUID(),
    sessionId,
    kind,
    at: new Date(nowMs).toISOString(),
    detail
  };
}

export function resetViolationsForTests(): void {
  lastBySession.clear();
}
