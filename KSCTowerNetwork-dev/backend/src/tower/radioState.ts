import type { SessionRecord, TelemetrySample } from "../services/repository";

const CHANNEL_STEP_MHZ = 0.025;
const BUSY_HOLD_MS = 2500;
const BLOCKED_HOLD_MS = 6000;
const BLOCK_DEDUPE_MS = 4000;

export type RadioState = {
  busy: boolean;
  blocked: boolean;
  freqMhz?: number;
  transmitterSessionId?: string;
  transmitterCallsign?: string;
  startedAtMs?: number;
  updatedAtMs: number;
  expiresAtMs?: number;
  blockedAtMs?: number;
  blockedBySessionId?: string;
  blockedByCallsign?: string;
  blockedWithSessionId?: string;
  blockedWithCallsign?: string;
  message?: string;
};

type Occupant = {
  sessionId: string;
  callsign?: string;
  freqMhz: number;
  startedAtMs: number;
  updatedAtMs: number;
};

type BlockedEvent = {
  atMs: number;
  freqMhz: number;
  bySessionId: string;
  byCallsign?: string;
  withSessionId: string;
  withCallsign?: string;
};

const occupantsByChannel = new Map<string, Occupant>();
const blockedBySession = new Map<string, BlockedEvent>();
const blockDedupeUntil = new Map<string, number>();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function channelKey(freqMhz: number): string {
  const snapped = Math.round(freqMhz / CHANNEL_STEP_MHZ) * CHANNEL_STEP_MHZ;
  return snapped.toFixed(3);
}

function prune(nowMs: number): void {
  for (const [key, occupant] of occupantsByChannel) {
    if (nowMs - occupant.updatedAtMs > BUSY_HOLD_MS) {
      occupantsByChannel.delete(key);
    }
  }
  for (const [sessionId, event] of blockedBySession) {
    if (nowMs - event.atMs > BLOCKED_HOLD_MS) {
      blockedBySession.delete(sessionId);
    }
  }
  for (const [key, untilMs] of blockDedupeUntil) {
    if (nowMs >= untilMs) {
      blockDedupeUntil.delete(key);
    }
  }
}

function callsignFor(session: SessionRecord, telemetry: TelemetrySample): string | undefined {
  return session.callsign?.trim() || telemetry.callsign?.trim() || telemetry.pilotName?.trim() || undefined;
}

function rememberBlocked(nowMs: number, freqMhz: number, by: { sessionId: string; callsign?: string }, withOcc: Occupant): void {
  const pair = [by.sessionId, withOcc.sessionId].sort().join(":");
  const key = `${channelKey(freqMhz)}:${pair}`;
  const dedupeUntil = blockDedupeUntil.get(key) ?? 0;
  if (nowMs < dedupeUntil) return;

  const event: BlockedEvent = {
    atMs: nowMs,
    freqMhz,
    bySessionId: by.sessionId,
    byCallsign: by.callsign,
    withSessionId: withOcc.sessionId,
    withCallsign: withOcc.callsign
  };
  blockedBySession.set(by.sessionId, event);
  blockedBySession.set(withOcc.sessionId, event);
  blockDedupeUntil.set(key, nowMs + BLOCK_DEDUPE_MS);
}

function toRadioState(nowMs: number, sessionId: string, freqMhz: number | undefined, occupant: Occupant | undefined): RadioState {
  const blocked = blockedBySession.get(sessionId);
  const blockedActive = blocked != null && nowMs - blocked.atMs <= BLOCKED_HOLD_MS;
  const busy = occupant != null && nowMs - occupant.updatedAtMs <= BUSY_HOLD_MS;
  const state: RadioState = {
    busy,
    blocked: blockedActive,
    freqMhz: freqMhz ?? blocked?.freqMhz ?? occupant?.freqMhz,
    transmitterSessionId: occupant?.sessionId,
    transmitterCallsign: occupant?.callsign,
    startedAtMs: occupant?.startedAtMs,
    updatedAtMs: nowMs,
    expiresAtMs: occupant ? occupant.updatedAtMs + BUSY_HOLD_MS : undefined,
    blockedAtMs: blockedActive ? blocked.atMs : undefined,
    blockedBySessionId: blockedActive ? blocked.bySessionId : undefined,
    blockedByCallsign: blockedActive ? blocked.byCallsign : undefined,
    blockedWithSessionId: blockedActive ? blocked.withSessionId : undefined,
    blockedWithCallsign: blockedActive ? blocked.withCallsign : undefined,
    message: blockedActive ? "BLOCKED - SAY AGAIN" : busy ? "FREQ BUSY" : undefined
  };
  return state;
}

export function updateRadioStateForTelemetry(
  sessionId: string,
  prevTelemetry: TelemetrySample | undefined,
  telemetry: TelemetrySample,
  session: SessionRecord,
  nowMs = Date.now()
): RadioState | undefined {
  prune(nowMs);

  const freqMhz = isFiniteNumber(telemetry.radioFreqMhz) ? telemetry.radioFreqMhz : undefined;
  const prevFreqMhz = isFiniteNumber(prevTelemetry?.radioFreqMhz) ? prevTelemetry?.radioFreqMhz : undefined;
  const activeKey = freqMhz == null ? undefined : channelKey(freqMhz);
  const prevKey = prevFreqMhz == null ? undefined : channelKey(prevFreqMhz);

  if (prevKey && prevKey !== activeKey) {
    const prevOcc = occupantsByChannel.get(prevKey);
    if (prevOcc?.sessionId === sessionId) {
      occupantsByChannel.delete(prevKey);
    }
  }

  if (!activeKey || freqMhz == null) {
    return undefined;
  }

  const existing = occupantsByChannel.get(activeKey);
  const isTransmitting = telemetry.radioPtt === true;
  if (isTransmitting) {
    const callsign = callsignFor(session, telemetry);
    if (existing && existing.sessionId !== sessionId && nowMs - existing.updatedAtMs <= BUSY_HOLD_MS) {
      rememberBlocked(nowMs, freqMhz, { sessionId, callsign }, existing);
    } else {
      occupantsByChannel.set(activeKey, {
        sessionId,
        callsign,
        freqMhz,
        startedAtMs: existing?.sessionId === sessionId ? existing.startedAtMs : nowMs,
        updatedAtMs: nowMs
      });
    }
  } else if (existing?.sessionId === sessionId) {
    occupantsByChannel.delete(activeKey);
  }

  return toRadioState(nowMs, sessionId, freqMhz, occupantsByChannel.get(activeKey));
}

export function resetRadioStateForTests(): void {
  occupantsByChannel.clear();
  blockedBySession.clear();
  blockDedupeUntil.clear();
}
