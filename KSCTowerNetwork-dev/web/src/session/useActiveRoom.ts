import { useEffect, useRef } from "react";
import { useApiQuery, useQueryClient } from "../query/hooks";
import { queryKeys } from "../query/client";
import { SESSION_STORAGE_KEY } from "./constants";

/**
 * Server-truth view of the caller's current tower room. Mirrors the payload
 * shape returned by `GET /v1/me/active-room`.
 *
 * The web shell used to derive "am I in a room?" from a localStorage value,
 * which let the topbar show stale session ids and let `/tower` mount with no
 * real session (silently latching onto the `dev-shared` bootstrap session, so
 * voice "looked ready" while talking into an empty LiveKit room). Now the
 * shell polls the server, the server decides, and the SPA conforms.
 */
export type ActiveRoom = {
  roomId: string;
  /** Always populated — backend backfills callsign-derived defaults. */
  roomName: string;
  name: string | null;
  /** Cosmetic notional VHF freq, e.g. "118.300". Always populated. */
  frequencyMhz: string | null;
  status: string;
  /**
   * Caller's role in this room. `pilot` and `controller` are the active roles —
   * they can publish chat, voice, telemetry edits, advance the tower, rename and
   * close the room. `spectator` is a read-only listener that joined via
   * `POST /v1/session/:id/spectate`; the desks render in read-only mode and the
   * LiveKit token comes back with `canPublish: false`.
   */
  myRole: "pilot" | "controller" | "spectator";
  towerPresent: boolean;
  /** How many spectators are currently listening (excluding pilot/controller). */
  spectatorCount?: number;
  /**
   * Booth kill-switch state. When true the spectator commentary booth (text +
   * voice) is gagged for non-moderators until the assigned tower controller or
   * a mod lifts it via `POST /v1/session/:id/booth/mute`.
   */
  boothMuted?: boolean;
  updatedAt: string;
};

type ApiPayload = {
  ok?: boolean;
  activeRoom?: ActiveRoom | null;
};

/** Polling cadence — matches the lobby's room list refresh so they stay roughly in sync. */
const POLL_MS = 3_000;

function writeStoredRoomId(roomId: string): void {
  try {
    if (roomId) {
      localStorage.setItem(SESSION_STORAGE_KEY, roomId);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // ignore (private mode)
  }
}

export type ActiveRoomState = {
  /** `true` once the first poll has resolved, even if the result is "no room". */
  loaded: boolean;
  activeRoom: ActiveRoom | null;
  /** When set, the most recent poll could not reach the API. UI should keep showing the last known room. */
  apiOffline: boolean;
  /** Force an immediate refetch (e.g. right after creating or joining a room). */
  refresh: () => void;
};

/**
 * Polls `GET /v1/me/active-room` via TanStack Query and exposes the canonical
 * "current room" view.
 *
 * Side effect: keeps `localStorage[SESSION_STORAGE_KEY]` in sync with the
 * server's answer so all the desks (TowerDesk, ChatDesk, VoiceDesk,
 * TowerWallPage) load the right session without any extra plumbing. When the
 * server says "you're not in a room", the storage entry is cleared — the
 * desks treat that as the empty state instead of falling back to `dev-shared`.
 *
 * `enabled` lets the App skip the poll on the login screen; we don't call
 * this for unauthenticated users (the request would just 401 in a tight loop).
 */
export function useActiveRoom(enabled: boolean): ActiveRoomState {
  const qc = useQueryClient();
  const q = useApiQuery<ApiPayload>({
    queryKey: queryKeys.me.activeRoom,
    path: "/v1/me/active-room",
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    refetchIntervalInBackground: false,
    // Keep the previous value during a refetch so the topbar pill doesn't
    // flicker between "ROOM" and "NO ROOM" each tick.
    placeholderData: (prev) => prev
  });

  const polledActiveRoom = enabled ? q.data?.activeRoom ?? null : null;
  const lastKnownActiveRoomRef = useRef<ActiveRoom | null>(null);
  if (polledActiveRoom) {
    lastKnownActiveRoomRef.current = polledActiveRoom;
  }
  const activeRoom =
    enabled && q.error?.unreachable
      ? lastKnownActiveRoomRef.current
      : polledActiveRoom;

  // Sync server-truth into localStorage. Done as an effect (not inside the
  // query) so React renders the new value before any storage listener fires
  // — keeps the desks consistent with what the topbar is displaying.
  useEffect(() => {
    if (!enabled) {
      writeStoredRoomId("");
      return;
    }
    // Keep the last known room on temporary API outages; clearing storage here
    // would bounce /tower to /lobby and tear down voice for transient network hiccups.
    if (q.error?.unreachable) return;
    if (q.isFetching && !q.data) return;
    writeStoredRoomId(activeRoom?.roomId ?? "");
  }, [enabled, q.error?.unreachable, q.isFetching, q.data, activeRoom?.roomId]);

  // Cross-tab: if another tab cleared the stored id (e.g. signed out), drop
  // our cached room so the topbar updates immediately instead of waiting on
  // the next poll.
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key !== SESSION_STORAGE_KEY) return;
      // Force an immediate refetch — the source of truth is still the server.
      void qc.invalidateQueries({ queryKey: queryKeys.me.activeRoom });
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [qc]);

  return {
    loaded: enabled ? q.isFetched : false,
    activeRoom,
    apiOffline: !!q.error?.unreachable,
    refresh: () => void qc.invalidateQueries({ queryKey: queryKeys.me.activeRoom })
  };
}

/** Read-only helper for callers that only need the stored id (e.g. desks, on first paint). */
export function getStoredRoomId(): string {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Cached-only read of the current active room. Use this in child components
 * (desks, banners, role-aware buttons) that only need to know "what role am I
 * in this room?" — they can subscribe to the same TanStack query the App
 * already runs without spawning a second poll or duplicating the localStorage
 * sync side effect from `useActiveRoom`.
 *
 * Returns `null` if the App-level poll hasn't returned yet or the user isn't
 * in any room. Callers that need to gate UI on "spectator vs participant"
 * should treat `null` as "unknown — assume read-only" to avoid flashing a
 * write affordance the next poll will take away.
 */
export function useActiveRoomCached(): ActiveRoom | null {
  // Re-using the same queryKey as useActiveRoom means we read the cached value
  // populated by the App-level poll (dedupe via TanStack). `enabled: false`
  // prevents this hook from issuing its own HTTP request.
  const q = useApiQuery<ApiPayload>({
    queryKey: queryKeys.me.activeRoom,
    path: "/v1/me/active-room",
    enabled: false,
    refetchInterval: false,
    placeholderData: (prev) => prev
  });
  return q.data?.activeRoom ?? null;
}
