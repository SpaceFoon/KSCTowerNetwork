import { env } from "./config/env";
import { logger } from "./lib/logger";
import {
  closeSession,
  listSessionsMerged,
  logAction,
  type SessionRecord
} from "./services/repository";

/**
 * Pure predicate for unit tests and the periodic sweep. When true, the session
 * may be soft-closed because the pilot's telemetry stream has been silent too long.
 */
export function isPilotIdleForAutoClose(
  s: SessionRecord,
  nowMs: number,
  idleCloseSeconds: number
): boolean {
  if (idleCloseSeconds <= 0) return false;
  if (s.status === "closed") return false;
  if (s.id === "dev-shared") return false;
  if (s.id.startsWith("ksc-radio-")) return false;
  if (s.id.startsWith("KSC-TOWER-")) return false;
  if (!s.lastTelemetryAt) return false;
  const t = Date.parse(s.lastTelemetryAt);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) / 1000 >= idleCloseSeconds;
}

async function sweepOnce(): Promise<void> {
  const idleCloseSeconds = env.PILOT_IDLE_CLOSE_SECONDS;
  if (idleCloseSeconds <= 0) {
    return;
  }

  const nowMs = Date.now();
  const sessions = await listSessionsMerged();

  for (const s of sessions) {
    if (!isPilotIdleForAutoClose(s, nowMs, idleCloseSeconds)) {
      continue;
    }
    const closed = await closeSession(s.id);
    if (!closed || closed.status !== "closed") {
      continue;
    }
    const actor = env.OWNER_USER_ID ?? "system";
    await logAction(actor, "session.close.pilot_idle", {
      sessionId: s.id,
      pilotUserId: s.pilotUserId,
      lastTelemetryAt: s.lastTelemetryAt,
      idleCloseSeconds
    });
    logger.info(
      { sessionId: s.id, pilotUserId: s.pilotUserId, lastTelemetryAt: s.lastTelemetryAt },
      "Auto-closed tower session (pilot telemetry idle)"
    );
  }
}

/**
 * Starts a timer that soft-closes pilot sessions with no telemetry for
 * {@link env.PILOT_IDLE_CLOSE_SECONDS}. Returns a disposer cleared on process shutdown.
 */
export function startPilotIdleSessionSweep(): () => void {
  if (env.PILOT_IDLE_CLOSE_SECONDS <= 0) {
    logger.info("Pilot idle session sweep disabled (PILOT_IDLE_CLOSE_SECONDS=0)");
    return () => {};
  }

  const intervalMs = env.PILOT_IDLE_SWEEP_INTERVAL_SECONDS * 1000;
  const timer = setInterval(() => {
    void sweepOnce().catch((err: unknown) => {
      logger.warn({ err }, "pilot idle session sweep tick failed");
    });
  }, intervalMs);

  logger.info(
    {
      pilotIdleCloseSeconds: env.PILOT_IDLE_CLOSE_SECONDS,
      pilotIdleSweepIntervalSeconds: env.PILOT_IDLE_SWEEP_INTERVAL_SECONDS
    },
    "Pilot idle session sweep enabled"
  );

  return () => {
    clearInterval(timer);
  };
}
