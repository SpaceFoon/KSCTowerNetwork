import { env } from "../config/env";
import type { SessionRecord } from "../services/repository";
import type { ApproachSequence } from "./approachQueue";
import type { StagingMoveRequest } from "./stagingMoveTypes";
import type { ViolationEvent } from "./violations";

const COUNTDOWN_STALE_GRACE_SEC = 5;

export type TelemetryReplyPayload = {
  ok: true;
  sessionId: string;
  nextTelemetrySeconds: number;
  serverNowMs: number;
  countdown?: { startsAtMs: number; lengthSec: number };
  /** Epoch ms when tower last granted takeoff (cockpit request button turns green until +10s). */
  takeoffClearanceAtMs?: number;
  clearances?: SessionRecord["clearances"];
  recentViolations?: ViolationEvent[];
  phaseTimeline?: Array<{ code: string; at: string }>;
  radio?: SessionRecord["radioState"];
  approachSequence?: ApproachSequence | null;
  lastLandingQuality?: SessionRecord["lastLandingQuality"];
  /** Tower-issued ramp position hint for the KSP client (optional Vessel Mover integration). */
  stagingMoveRequest?: StagingMoveRequest;
};

export function buildTelemetryReplyPayload(
  session: SessionRecord,
  extras?: {
    approachSequence?: ApproachSequence | null;
  }
): TelemetryReplyPayload {
  const radarAlt = session.telemetry?.radarAlt ?? Number.POSITIVE_INFINITY;
  let nextTelemetrySeconds =
    radarAlt < env.TELEMETRY_CLOSE_AGL_M ? env.TELEMETRY_CLOSE_SECONDS : env.TELEMETRY_DEFAULT_SECONDS;
  let countdown: { startsAtMs: number; lengthSec: number } | undefined;
  if (session.countdownStartsAt && session.countdownLengthSec != null) {
    const startMs = Date.parse(session.countdownStartsAt);
    const endMs = startMs + (session.countdownLengthSec + COUNTDOWN_STALE_GRACE_SEC) * 1000;
    if (Date.now() < endMs) {
      countdown = { startsAtMs: startMs, lengthSec: session.countdownLengthSec };
      nextTelemetrySeconds = Math.min(nextTelemetrySeconds, 1);
    }
  }
  const serverNowMs = Date.now();
  let takeoffClearanceAtMs: number | undefined;
  if (session.takeoffClearanceAt) {
    const t = Date.parse(session.takeoffClearanceAt);
    if (Number.isFinite(t) && serverNowMs < t + 10_000) {
      takeoffClearanceAtMs = t;
    }
  }
  return {
    ok: true,
    sessionId: session.id,
    nextTelemetrySeconds,
    serverNowMs,
    countdown,
    takeoffClearanceAtMs,
    clearances: session.clearances,
    recentViolations: session.recentViolations?.slice(-8),
    phaseTimeline: session.phaseTimeline?.slice(-12),
    radio: session.radioState,
    approachSequence: extras?.approachSequence ?? null,
    lastLandingQuality: session.lastLandingQuality,
    stagingMoveRequest: session.stagingMoveRequest
  };
}
