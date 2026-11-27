import dgram from "node:dgram";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { emitChecklistEvent } from "../services/checklistEvents";
import { DEFAULT_CHECKLIST_PHASES } from "../services/defaultChecklist";
import { isKscTowerSessionId } from "../services/hullcamStore";
import {
  appendSessionMessage,
  awardEvent,
  checklistSideComplete,
  evaluateAndApplyAutoRules,
  getSession,
  getSessionWithDevSharedBootstrap,
  getUserAccess,
  isOwnerImmuneId,
  setTelemetry,
  setTelemetryStatus,
  type TelemetryStatusEvent
} from "../services/repository";
import { detectFromTelemetry } from "../services/scoring";
import { publishLiveSnapshotEvent } from "./liveSnapshotBus";
import { runTowerTelemetryHooks } from "../tower/afterTelemetry";
import { buildTelemetryReplyPayload } from "../tower/telemetryReplyPayload";
import { incLiveMetric } from "./metrics";
import {
  LIVE_UDP_PROTOCOL_VERSION,
  decodeLiveUdpJson,
  decodeLiveUdpPacket,
  encodeLiveUdpJson,
  encodeLiveUdpPacket
} from "./protocol";
import { getActiveAircraftSnapshot } from "./snapshotCache";
import { telemetrySchema, telemetryStatusSchema } from "../validation/telemetrySchemas";

/**
 * UDP does not preserve order, so a delayed or duplicated packet must not replace newer
 * state. Packets from one sender stream are ordered by the timestamp the sender stamps on
 * them. A sender clock far from ours cannot be ordered against, so those packets are accepted.
 */
const SENDER_CLOCK_TRUST_MS = 30_000;
const lastSenderTimestampByStream = new Map<string, number>();

function isStaleSenderPacket(streamKey: string, senderTimestampMs: number): boolean {
  const now = Date.now();
  if (Math.abs(now - senderTimestampMs) > SENDER_CLOCK_TRUST_MS) return false;
  const last = lastSenderTimestampByStream.get(streamKey);
  if (last !== undefined && Math.abs(now - last) <= SENDER_CLOCK_TRUST_MS && senderTimestampMs <= last) {
    return true;
  }
  lastSenderTimestampByStream.set(streamKey, senderTimestampMs);
  return false;
}

/**
 * A ghost snapshot is much larger than the query that asks for it, so the same source address
 * may not ask for one more than a few times a second.
 */
const GHOST_QUERY_WINDOW_MS = 1000;
const GHOST_QUERY_LIMIT_PER_SOURCE = 4;
const ghostQueryBySource = new Map<string, { windowStartMs: number; count: number }>();

function allowGhostQuery(address: string): boolean {
  const now = Date.now();
  const bucket = ghostQueryBySource.get(address);
  if (!bucket || now - bucket.windowStartMs >= GHOST_QUERY_WINDOW_MS) {
    ghostQueryBySource.set(address, { windowStartMs: now, count: 1 });
    return true;
  }
  if (bucket.count >= GHOST_QUERY_LIMIT_PER_SOURCE) return false;
  bucket.count += 1;
  return true;
}

/** Exposed for unit tests only. */
export const __udpTestHooks = { isStaleSenderPacket, allowGhostQuery };

type TelemetryEffectJob = {
  sessionId: string;
  pilotUserId: string;
  prevSample: unknown;
  telemetry: unknown;
};

const telemetryEffectQueue: TelemetryEffectJob[] = [];
const MAX_PENDING_TELEMETRY_EFFECTS = 256;
const TELEMETRY_RATE_WINDOW_MS = 1000;
const TELEMETRY_RATE_LIMIT_PER_SECOND = 15;
const telemetryRateByUser = new Map<string, { windowStartMs: number; count: number }>();
let processingTelemetryEffects = false;
let lastTelemetryQueueWarningAt = 0;

function allowTelemetryRate(userId: string): boolean {
  const now = Date.now();
  const bucket = telemetryRateByUser.get(userId);
  if (!bucket || now - bucket.windowStartMs >= TELEMETRY_RATE_WINDOW_MS) {
    telemetryRateByUser.set(userId, { windowStartMs: now, count: 1 });
    return true;
  }
  if (bucket.count >= TELEMETRY_RATE_LIMIT_PER_SECOND) return false;
  bucket.count += 1;
  return true;
}

function enqueueTelemetryEffects(job: TelemetryEffectJob): void {
  if (telemetryEffectQueue.length >= MAX_PENDING_TELEMETRY_EFFECTS) {
    incLiveMetric("udp_packets_dropped");
    const now = Date.now();
    if (now - lastTelemetryQueueWarningAt >= 30_000) {
      lastTelemetryQueueWarningAt = now;
      logger.warn({ queueLength: telemetryEffectQueue.length }, "UDP telemetry side-effect queue is full; dropping work");
    }
    return;
  }
  telemetryEffectQueue.push(job);
  if (processingTelemetryEffects) return;
  processingTelemetryEffects = true;
  setImmediate(async () => {
    try {
      while (telemetryEffectQueue.length > 0) {
        const next = telemetryEffectQueue.shift();
        if (!next) break;
        const sessionEpochSec = Math.floor(Date.now() / 1000);
        try {
          const events = detectFromTelemetry(
            next.prevSample as Parameters<typeof detectFromTelemetry>[0],
            next.telemetry as Parameters<typeof detectFromTelemetry>[1],
            next.sessionId,
            sessionEpochSec
          );
          for (const ev of events) {
            const dedupeBucket = `${next.sessionId}:${ev.kind}:${ev.bucketSec}`;
            // eslint-disable-next-line no-await-in-loop
            await awardEvent({
              sessionId: next.sessionId,
              targetUserId: next.pilotUserId,
              kind: ev.kind,
              points: ev.points,
              label: ev.label,
              source: "auto",
              dedupeBucket
            });
            // eslint-disable-next-line no-await-in-loop
            await appendSessionMessage(next.sessionId, "system", `[${ev.kind.toUpperCase()}] ${ev.label}`);
          }
        } catch (error) {
          logger.warn({ err: error, sessionId: next.sessionId }, "UDP telemetry scoring side-effect failed");
        }

        try {
          const session = await getSession(next.sessionId);
          if (!session) continue;
          const phases = session.checklistPhases ?? DEFAULT_CHECKLIST_PHASES;
          const flipped = await evaluateAndApplyAutoRules(
            next.sessionId,
            phases,
            next.telemetry as Parameters<typeof evaluateAndApplyAutoRules>[2]
          );
          if (flipped.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            await appendSessionMessage(
              next.sessionId,
              "system",
              `[CHECKLIST] auto-ticked ${flipped.length} pilot item${flipped.length === 1 ? "" : "s"}`
            );
            // eslint-disable-next-line no-await-in-loop
            const refreshed = await getSession(next.sessionId);
            const sideComplete =
              refreshed != null && checklistSideComplete(phases, refreshed.checklistState, "pilot");
            if (sideComplete) {
              // eslint-disable-next-line no-await-in-loop
              await appendSessionMessage(next.sessionId, "system", "[CHECKLIST] pilot side complete ✓");
            }
            emitChecklistEvent({
              kind: "auto",
              sessionId: next.sessionId,
              at: new Date().toISOString(),
              itemIds: flipped
            });
            emitChecklistEvent({
              kind: "state",
              sessionId: next.sessionId,
              at: new Date().toISOString(),
              itemIds: flipped
            });
          }
        } catch (error) {
          logger.warn({ err: error, sessionId: next.sessionId }, "UDP telemetry checklist side-effect failed");
        }
      }
    } finally {
      processingTelemetryEffects = false;
      const next = telemetryEffectQueue.shift();
      if (next) {
        enqueueTelemetryEffects(next);
      }
    }
  });
}

async function authorizePacket(token: string): Promise<{ userId: string } | null> {
  // Reusable app JWTs must never cross the UDP transport. Authenticated
  // production traffic uses the HTTPS fallback; empty-token UDP is dev-only.
  if (token || !env.DEV_OPEN_AUTH) return null;
  const userId = env.DEV_USER_ID;
  if (!isOwnerImmuneId(userId) && (await getUserAccess(userId)).isBanned) return null;
  return { userId };
}

export function startUdpLiveWorker(): () => void {
  if (!env.LIVE_UDP_ENABLED) {
    logger.info("UDP live worker disabled (LIVE_UDP_ENABLED=false)");
    return () => {};
  }
  const socket = dgram.createSocket("udp4");

  socket.on("error", (err) => {
    logger.error({ err }, "UDP live worker socket error");
  });

  socket.on("message", async (frame, rinfo) => {
    if (frame.length > env.LIVE_UDP_MAX_PACKET_BYTES) {
      incLiveMetric("udp_packets_dropped");
      return;
    }
    incLiveMetric("udp_packets_in");
    let packet: ReturnType<typeof decodeLiveUdpPacket>;
    try {
      packet = decodeLiveUdpPacket(frame);
    } catch (error) {
      incLiveMetric("udp_decode_errors");
      logger.debug({ err: error }, "UDP decode failed");
      return;
    }

    if (packet.version !== LIVE_UDP_PROTOCOL_VERSION) {
      incLiveMetric("udp_packets_dropped");
      return;
    }

    const auth = await authorizePacket(packet.token);
    if (!auth?.userId) {
      incLiveMetric("udp_auth_errors");
      return;
    }

    const replyError = (error: string): void => {
      const payload = encodeLiveUdpJson({ ok: false, error });
      const out = encodeLiveUdpPacket({
        version: LIVE_UDP_PROTOCOL_VERSION,
        type: "reply.error",
        flags: 0,
        sequence: packet.sequence,
        timestampMs: Date.now(),
        sessionId: packet.sessionId,
        token: "",
        payload
      });
      socket.send(out, rinfo.port, rinfo.address);
      incLiveMetric("udp_replies_out");
    };

    try {
      if (packet.type === "ghost.query") {
        if (!allowGhostQuery(rinfo.address)) {
          incLiveMetric("udp_packets_dropped");
          return;
        }
        const data = await getActiveAircraftSnapshot(auth.userId);
        const out = encodeLiveUdpPacket({
          version: LIVE_UDP_PROTOCOL_VERSION,
          type: "reply.ok",
          flags: 0,
          sequence: packet.sequence,
          timestampMs: Date.now(),
          sessionId: packet.sessionId,
          token: "",
          payload: encodeLiveUdpJson(data)
        });
        // Bigger than one datagram: the client gets it over HTTP instead, and a spoofed
        // source never receives an oversized reflection.
        if (out.length > env.LIVE_UDP_MAX_PACKET_BYTES) {
          replyError("Snapshot too large for UDP; query over HTTP");
          return;
        }
        socket.send(out, rinfo.port, rinfo.address);
        incLiveMetric("udp_replies_out");
        return;
      }

      if (packet.type === "telemetry.sample") {
        if (isKscTowerSessionId(packet.sessionId)) {
          replyError("KSC tower view-stream sessions cannot publish telemetry");
          return;
        }
        const existing = await getSessionWithDevSharedBootstrap(packet.sessionId, auth.userId);
        if (!existing) {
          replyError("Session not found");
          return;
        }
        const devSharedOpenTelemetry =
          packet.sessionId === "dev-shared" &&
          (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
          env.DEV_OPEN_AUTH;
        if (!devSharedOpenTelemetry && auth.userId !== existing.pilotUserId) {
          replyError("Only pilot can submit telemetry for this session");
          return;
        }
        if (!allowTelemetryRate(auth.userId)) {
          incLiveMetric("udp_packets_dropped");
          return;
        }

        // Same schema as the HTTP route: an unvalidated sample would otherwise be persisted and
        // read back by the map, scoring and UI code, which all assume the declared shape.
        const telemetryParsed = telemetrySchema.safeParse(decodeLiveUdpJson<unknown>(packet.payload));
        if (!telemetryParsed.success) {
          incLiveMetric("udp_packets_dropped");
          replyError("Invalid telemetry sample");
          return;
        }
        if (isStaleSenderPacket(`telemetry.sample|${packet.sessionId}|${auth.userId}`, packet.timestampMs)) {
          incLiveMetric("udp_packets_dropped");
          return;
        }
        const telemetry = telemetryParsed.data;
        const prevSample = existing.telemetry;
        const session = await setTelemetry(packet.sessionId, telemetry as Parameters<typeof setTelemetry>[1]);
        if (!session) {
          replyError("Session not found");
          return;
        }
        publishLiveSnapshotEvent({ topic: "session", sessionId: packet.sessionId });
        publishLiveSnapshotEvent({ topic: "active-aircraft" });
        enqueueTelemetryEffects({
          sessionId: packet.sessionId,
          pilotUserId: existing.pilotUserId,
          prevSample,
          telemetry: session.telemetry ?? telemetry
        });

        let approachSequence: { index: number; of: number; gapKmBehindLeader?: number } | null = null;
        try {
          const hook = await runTowerTelemetryHooks(
            packet.sessionId,
            prevSample,
            (session.telemetry ?? telemetry) as Parameters<typeof runTowerTelemetryHooks>[2],
            session
          );
          approachSequence = hook.approachSequence;
        } catch {
          // ignore
        }

        const out = encodeLiveUdpPacket({
          version: LIVE_UDP_PROTOCOL_VERSION,
          type: "reply.ok",
          flags: 0,
          sequence: packet.sequence,
          timestampMs: Date.now(),
          sessionId: packet.sessionId,
          token: "",
          payload: encodeLiveUdpJson(buildTelemetryReplyPayload(session, { approachSequence }))
        });
        socket.send(out, rinfo.port, rinfo.address);
        incLiveMetric("udp_replies_out");
        return;
      }

      if (packet.type === "telemetry.status") {
        if (isKscTowerSessionId(packet.sessionId)) {
          replyError("KSC tower view-stream sessions cannot publish telemetry status");
          return;
        }
        const existing = await getSessionWithDevSharedBootstrap(packet.sessionId, auth.userId);
        if (!existing) {
          replyError("Session not found");
          return;
        }
        const devSharedOpenTelemetry =
          packet.sessionId === "dev-shared" &&
          (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
          env.DEV_OPEN_AUTH;
        if (!devSharedOpenTelemetry && auth.userId !== existing.pilotUserId) {
          replyError("Only pilot can publish telemetry status for this session");
          return;
        }
        if (!allowTelemetryRate(auth.userId)) {
          incLiveMetric("udp_packets_dropped");
          return;
        }
        const statusParsed = telemetryStatusSchema.safeParse(decodeLiveUdpJson<unknown>(packet.payload));
        if (!statusParsed.success) {
          incLiveMetric("udp_packets_dropped");
          replyError("Invalid telemetry status");
          return;
        }
        if (isStaleSenderPacket(`telemetry.status|${packet.sessionId}|${auth.userId}`, packet.timestampMs)) {
          incLiveMetric("udp_packets_dropped");
          return;
        }
        const event: TelemetryStatusEvent = {
          state: statusParsed.data.state,
          at: new Date().toISOString(),
          message: statusParsed.data.message
        };
        const session = await setTelemetryStatus(packet.sessionId, event);
        if (!session) {
          replyError("Session not found");
          return;
        }
        publishLiveSnapshotEvent({ topic: "session", sessionId: packet.sessionId });
        publishLiveSnapshotEvent({ topic: "active-aircraft" });
        const out = encodeLiveUdpPacket({
          version: LIVE_UDP_PROTOCOL_VERSION,
          type: "reply.ok",
          flags: 0,
          sequence: packet.sequence,
          timestampMs: Date.now(),
          sessionId: packet.sessionId,
          token: "",
          payload: encodeLiveUdpJson({ ok: true, sessionId: session.id, telemetryStatus: event })
        });
        socket.send(out, rinfo.port, rinfo.address);
        incLiveMetric("udp_replies_out");
        return;
      }

      replyError("Unknown message type");
    } catch (error) {
      incLiveMetric("udp_handler_errors");
      logger.warn({ err: error }, "UDP live packet handler failed");
    }
  });

  const port = env.LIVE_UDP_PORT;
  const host = env.LIVE_UDP_HOST;
  socket.bind(port, host, () => {
    logger.info({ host, port }, "UDP live worker listening");
  });

  return () => {
    try {
      socket.close();
    } catch {
      // ignore
    }
  };
}
