import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env, getLiveKitWsUrl } from "../config/env";

const BRIDGE_LIVEKIT_IDENTITIES = new Set(
  env.LIVEKIT_BRIDGE_IDENTITIES.split(",").map((s) => s.trim()).filter(Boolean)
);

/**
 * True iff `userId` is one of the configured KSP voice-bridge identities (e.g.
 * `ksp_bridge`). The bridge is a non-human Node process that joins LiveKit
 * subscribe-only to forward in-game audio; it must never be treated as a
 * pilot/tower in session bookkeeping nor be listed in the admin Users panel.
 */
export function isBridgeIdentity(userId: string): boolean {
  return BRIDGE_LIVEKIT_IDENTITIES.has(userId);
}

/** Snapshot of configured bridge identities (for admin/observability endpoints). */
export function listBridgeIdentities(): string[] {
  return Array.from(BRIDGE_LIVEKIT_IDENTITIES);
}

/** Display name shown for the bridge in LiveKit + admin tooling. */
export function bridgeDisplayName(): string {
  return env.LIVEKIT_BRIDGE_DISPLAY_NAME.trim() || "KSP voice bridge";
}

function liveKitParticipantName(userId: string, jwtDisplayName?: string): string | undefined {
  if (BRIDGE_LIVEKIT_IDENTITIES.has(userId)) {
    return env.LIVEKIT_BRIDGE_DISPLAY_NAME.trim() || undefined;
  }
  const t = jwtDisplayName?.trim();
  if (!t) {
    return undefined;
  }
  return t.length > 120 ? t.slice(0, 120) : t;
}

export function isLiveKitConfigured(): boolean {
  return Boolean(env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && getLiveKitWsUrl());
}

export async function issueLiveKitToken(params: {
  userId: string;
  roomName: string;
  canPublish: boolean;
  canSubscribe: boolean;
  /** From tower_web JWT; shown as LiveKit participant name for browser users. */
  displayName?: string;
  /** Small JSON blob exposed to other clients as LiveKit participant metadata. */
  metadata?: Record<string, unknown>;
}): Promise<{ token: string; wsUrl?: string }> {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error("LiveKit credentials are not configured");
  }

  const displayName = liveKitParticipantName(params.userId, params.displayName);
  const tokenOpts: { identity: string; ttl: string; name?: string; metadata?: string } = {
    identity: params.userId,
    ttl: "30m"
  };
  const metadata =
    params.metadata || BRIDGE_LIVEKIT_IDENTITIES.has(params.userId)
      ? {
          ...(params.metadata ?? {}),
          ...(BRIDGE_LIVEKIT_IDENTITIES.has(params.userId)
            ? {
                role: "ksp_voice_bridge",
                note: "Node bridge for in-game TCP PCM + optional Windows mic; KSP.exe is not a LiveKit client."
              }
            : {})
        }
      : undefined;
  if (metadata) {
    tokenOpts.metadata = JSON.stringify(metadata);
  }

  if (displayName) {
    tokenOpts.name = displayName;
  }

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, tokenOpts);

  at.addGrant({
    roomJoin: true,
    room: params.roomName,
    canPublish: params.canPublish,
    canSubscribe: params.canSubscribe
  });

  const ws = getLiveKitWsUrl();
  return {
    token: await at.toJwt(),
    wsUrl: ws
  };
}

function getRoomClient(): RoomServiceClient | null {
  const ws = getLiveKitWsUrl();
  if (!isLiveKitConfigured() || !ws || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return null;
  }
  const httpUrl = ws.replace(/^wss?:\/\//, "https://");
  return new RoomServiceClient(httpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

export async function ensureLiveKitRoom(roomName: string): Promise<void> {
  const roomClient = getRoomClient();
  if (!roomClient) return;
  try {
    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 5 * 60,
      maxParticipants: 50
    });
  } catch {
    // Ignore "already exists" and transient errors in MVP.
  }
}

/**
 * Best-effort enumeration of every room the identity is currently joined to. We list all rooms
 * then list participants per room — LiveKit doesn't expose a direct "find participant" call.
 * Used by the mute/ban paths so a muted user is silenced *now*, not only on next reconnect.
 */
async function findRoomsForIdentity(
  roomClient: RoomServiceClient,
  identity: string
): Promise<string[]> {
  try {
    const rooms = await roomClient.listRooms();
    const matches: string[] = [];
    await Promise.all(
      rooms.map(async (room) => {
        try {
          const parts = await roomClient.listParticipants(room.name);
          if (parts.some((p) => p.identity === identity)) {
            matches.push(room.name);
          }
        } catch {
          // skip room on transient list error
        }
      })
    );
    return matches;
  } catch {
    return [];
  }
}

/**
 * Cap on simultaneous LiveKit Server-API calls in fan-out helpers. Without this
 * a moderator banning a user who happens to be in 200 rooms triggers 200 parallel
 * API requests, which the LiveKit cloud rate-limits and which can starve the
 * Node event loop on the box.
 */
const LIVEKIT_FANOUT_CONCURRENCY = 8;

async function runWithConcurrencyCap<T, R>(
  items: T[],
  cap: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Kick an identity from every room they're in. Used on ban. No-op if LiveKit isn't configured. */
export async function kickIdentityFromAllRooms(identity: string): Promise<number> {
  const roomClient = getRoomClient();
  if (!roomClient) return 0;
  const rooms = await findRoomsForIdentity(roomClient, identity);
  let removed = 0;
  await runWithConcurrencyCap(rooms, LIVEKIT_FANOUT_CONCURRENCY, async (roomName) => {
    try {
      await roomClient.removeParticipant(roomName, identity);
      removed += 1;
    } catch {
      // participant may have already disconnected
    }
  });
  return removed;
}

// In-process kick cooldowns keyed by `${identity}|${roomName}`. Mods use this
// (via /admin/kick) to drop a noisy participant from one room and prevent the
// client's auto-rejoin loop from instantly grabbing a fresh token. We keep it
// in-memory on purpose: a kick is a soft, short-lived correction; a process
// restart wiping the map is the same as the cooldown expiring early. For
// permanent enforcement, ban instead.
const kickCooldowns = new Map<string, number>();

function kickCooldownKey(identity: string, roomName: string): string {
  return `${identity}|${roomName}`;
}

function pruneExpiredCooldowns(now: number = Date.now()): void {
  for (const [key, expiresAtMs] of kickCooldowns) {
    if (expiresAtMs <= now) kickCooldowns.delete(key);
  }
}

/**
 * Returns the remaining cooldown in seconds (rounded up) for `identity` in
 * `roomName`, or 0 if there is no active cooldown. Lazily prunes expired
 * entries on lookup so the map can't grow without bound.
 */
export function getKickCooldownRemainingSec(identity: string, roomName: string): number {
  const now = Date.now();
  const key = kickCooldownKey(identity, roomName);
  const expiresAtMs = kickCooldowns.get(key);
  if (!expiresAtMs) return 0;
  if (expiresAtMs <= now) {
    kickCooldowns.delete(key);
    return 0;
  }
  return Math.ceil((expiresAtMs - now) / 1000);
}

/**
 * Active kick cooldown describing one in-memory entry in `kickCooldowns`.
 * Returned by `listKickCooldowns()` so the AdminDesk Sanctions table can
 * show pending cooldowns alongside DB-backed bans/mutes and let an operator
 * lift them via `clearKickCooldown`.
 */
export interface KickCooldownEntry {
  identity: string;
  roomName: string;
  expiresAt: string;
  remainingSec: number;
}

/**
 * Snapshot every active kick cooldown. Lazily prunes expired rows so a long-
 * running process doesn't return entries that already lapsed.
 */
export function listKickCooldowns(): KickCooldownEntry[] {
  const now = Date.now();
  pruneExpiredCooldowns(now);
  const out: KickCooldownEntry[] = [];
  for (const [key, expiresAtMs] of kickCooldowns) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    out.push({
      identity: key.slice(0, sep),
      roomName: key.slice(sep + 1),
      expiresAt: new Date(expiresAtMs).toISOString(),
      remainingSec: Math.ceil((expiresAtMs - now) / 1000)
    });
  }
  return out.sort((a, b) => a.remainingSec - b.remainingSec);
}

/**
 * Lift a per-room kick cooldown immediately so the user can rejoin the
 * room before the timer naturally expires. When `roomName` is omitted, every
 * cooldown for the identity (across all rooms) is cleared. Returns the number
 * of cooldown entries that were actually removed.
 *
 * Note: this only removes the *cooldown*. If the user is currently banned
 * or muted, they remain banned/muted — those are separate enforcement
 * channels (see `unbanUser`/`unmuteUser`).
 */
export function clearKickCooldown(identity: string, roomName?: string): number {
  if (roomName) {
    return kickCooldowns.delete(kickCooldownKey(identity, roomName)) ? 1 : 0;
  }
  let cleared = 0;
  const prefix = `${identity}|`;
  for (const key of [...kickCooldowns.keys()]) {
    if (key.startsWith(prefix)) {
      kickCooldowns.delete(key);
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Mod-initiated soft kick: drop `identity` from a single LiveKit room and
 * record an in-memory cooldown so subsequent /livekit-token requests for that
 * same room get rejected for `cooldownSec` seconds. Returns whether the
 * LiveKit `removeParticipant` call actually found them in the room (false is
 * fine — they may have already disconnected; the cooldown still gets set).
 */
export async function kickIdentityFromRoom(
  identity: string,
  roomName: string,
  cooldownSec: number
): Promise<{ removed: boolean; cooldownExpiresAtMs: number }> {
  const safeCooldown = Math.max(1, Math.floor(cooldownSec));
  const cooldownExpiresAtMs = Date.now() + safeCooldown * 1000;
  pruneExpiredCooldowns();
  kickCooldowns.set(kickCooldownKey(identity, roomName), cooldownExpiresAtMs);

  const roomClient = getRoomClient();
  if (!roomClient) {
    // Cooldown still applies so token reissue is blocked even when LiveKit
    // isn't configured (dev / staging without a live SFU).
    return { removed: false, cooldownExpiresAtMs };
  }

  try {
    await roomClient.removeParticipant(roomName, identity);
    return { removed: true, cooldownExpiresAtMs };
  } catch {
    // Participant may have already disconnected, or the room doesn't exist.
    // The cooldown is the durable part of the kick; the SFU removal is a
    // best-effort "now" cleanup.
    return { removed: false, cooldownExpiresAtMs };
  }
}

/**
 * Toggle publish permission for every participant currently in `roomName`,
 * skipping any identity in `exemptIdentities` (typically the assigned tower
 * controller and any moderator riding the booth). Used by the booth
 * kill-switch so a tower seat can mute / unmute the entire spectator booth
 * without touching individual users. No-op when LiveKit isn't configured.
 *
 * Returns the number of participants whose publish permission was actually
 * updated. Failures on individual participants are swallowed (they may have
 * disconnected mid-fanout); the room-level operation is best-effort.
 */
export async function setPublishForRoomParticipants(
  roomName: string,
  canPublish: boolean,
  exemptIdentities: ReadonlySet<string>
): Promise<number> {
  const roomClient = getRoomClient();
  if (!roomClient) return 0;
  let participants;
  try {
    participants = await roomClient.listParticipants(roomName);
  } catch {
    return 0;
  }
  const targets = participants.filter(
    (p) => !exemptIdentities.has(p.identity) && !BRIDGE_LIVEKIT_IDENTITIES.has(p.identity)
  );
  let updated = 0;
  await runWithConcurrencyCap(targets, LIVEKIT_FANOUT_CONCURRENCY, async (p) => {
    try {
      await roomClient.updateParticipant(roomName, p.identity, undefined, {
        canPublish,
        canSubscribe: true,
        canPublishData: true
      });
      updated += 1;
    } catch {
      // participant may have already disconnected; skip silently
    }
  });
  return updated;
}

/**
 * Revoke publish permission for an identity across every room they're in. Used on mute so the
 * subscriber side keeps working but the mic is dropped immediately by the SFU.
 */
export async function revokePublishForIdentity(identity: string): Promise<number> {
  const roomClient = getRoomClient();
  if (!roomClient) return 0;
  const rooms = await findRoomsForIdentity(roomClient, identity);
  let updated = 0;
  await runWithConcurrencyCap(rooms, LIVEKIT_FANOUT_CONCURRENCY, async (roomName) => {
    try {
      await roomClient.updateParticipant(roomName, identity, undefined, {
        canPublish: false,
        canSubscribe: true,
        canPublishData: true
      });
      updated += 1;
    } catch {
      // participant may have already disconnected
    }
  });
  return updated;
}

/**
 * Restore publish permission for an identity across every room they're in.
 * Used on unmute so the mic comes back live without forcing a reconnect.
 * No-op when LiveKit isn't configured. Mirrors `revokePublishForIdentity`.
 */
export async function restorePublishForIdentity(identity: string): Promise<number> {
  const roomClient = getRoomClient();
  if (!roomClient) return 0;
  const rooms = await findRoomsForIdentity(roomClient, identity);
  let updated = 0;
  await runWithConcurrencyCap(rooms, LIVEKIT_FANOUT_CONCURRENCY, async (roomName) => {
    try {
      await roomClient.updateParticipant(roomName, identity, undefined, {
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
      });
      updated += 1;
    } catch {
      // participant may have already disconnected
    }
  });
  return updated;
}
