/**
 * Centralised TanStack Query setup. Everything in the SPA fetches through
 * `useApiQuery` / `useApiMutation` (in `./hooks.ts`), which call into our
 * existing `apiFetch` wrapper but normalise the result into a thrown error or
 * a typed payload — exactly the shape TanStack Query expects.
 *
 * Why one client for the whole app:
 *  - request dedupe (multiple components asking for `/v1/lobby/rooms` make one HTTP call)
 *  - shared cache (joining a room invalidates the lobby list everywhere)
 *  - automatic retry/backoff on transient network blips
 *  - refetchOnWindowFocus so an alt-tabbed user gets fresh data immediately
 *
 * Defaults are tuned for an ATC-ish app: short stale times so polled data feels
 * live, but `retry: 1` so a backend restart doesn't fan out into a retry storm.
 * Per-query overrides can opt into longer stale times (e.g. world inventory).
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Most data here is "live-ish" — we'd rather show a slightly old value
      // for a few hundred ms than block the UI while we refetch.
      staleTime: 1_000,
      // Background refetch on focus = the user alt-tabs back and immediately
      // sees current state without waiting for the next poll tick.
      refetchOnWindowFocus: true,
      // The user complained about the app "looking broken" when something is
      // wrong. Surface failures fast instead of silently retrying for 30s.
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000)
    },
    mutations: {
      // Mutations that fail are usually shown inline; let the caller decide.
      retry: 0
    }
  }
});

/**
 * Centralised query key factory. Every key starts with a domain tag so cache
 * invalidations are precise — e.g. after `POST /v1/session/call` we can do
 * `queryClient.invalidateQueries({ queryKey: queryKeys.lobby.all })` and it
 * updates the lobby list AND the active-room poll AND any session detail
 * fetches without each call site needing to know about the others.
 *
 * Keep this exhaustive: any new fetch should add itself here so we have one
 * place to look when reasoning about cache lifetime.
 */
export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const
  },
  site: {
    info: ["site", "info"] as const
  },
  me: {
    activeRoom: ["me", "active-room"] as const
  },
  lobby: {
    all: ["lobby"] as const,
    rooms: ["lobby", "rooms"] as const,
    messages: ["lobby", "messages"] as const,
    queueStatus: ["lobby", "queue-status"] as const
  },
  session: {
    all: ["session"] as const,
    detail: (sessionId: string) => ["session", "detail", sessionId] as const,
    messages: (sessionId: string) => ["session", "messages", sessionId] as const,
    boothMessages: (sessionId: string) => ["session", "booth-messages", sessionId] as const,
    activePilots: ["session", "active-pilots"] as const,
    kosScreen: (sessionId: string) => ["session", "kos-screen", sessionId] as const,
    hullCamCameras: (sessionId: string) => ["session", "hull-cam", "cameras", sessionId] as const,
    hullCamFrame: (sessionId: string, cameraId: string) =>
      ["session", "hull-cam", "frame", sessionId, cameraId] as const,
    livekitCaps: (sessionId: string) => ["session", "livekit-caps", sessionId] as const,
    scorecard: (sessionId: string) => ["session", "scorecard", sessionId] as const,
    checklist: (sessionId: string) => ["session", "checklist", sessionId] as const,
    dragonRadar: (sessionId: string) => ["session", "dragon-radar", sessionId] as const
  },
  world: {
    inventory: (sessionId: string) => ["world", "inventory", sessionId] as const,
    /** Per-session: manifest layer `url`s embed `sessionId`; a global key reused the wrong bake. */
    maps: (sessionId: string) => ["world", "maps", sessionId] as const
  },
  dm: {
    all: ["dm"] as const,
    peers: ["dm", "peers"] as const,
    threads: ["dm", "threads"] as const,
    messages: (peerUserId: string) => ["dm", "messages", peerUserId] as const
  },
  admin: {
    all: ["admin"] as const,
    serverLogs: ["admin", "server-logs"] as const,
    users: ["admin", "users"] as const,
    sessions: ["admin", "sessions"] as const,
    reports: ["admin", "reports"] as const,
    actionLog: ["admin", "action-log"] as const,
    sanctions: ["admin", "sanctions"] as const,
    inviteCodes: ["admin", "invite-codes"] as const
  },
  pilot: {
    profile: (userId: string) => ["pilot", "profile", userId] as const
  },
  tower: {
    all: ["tower"] as const,
    activeAircraft: () => ["tower", "active-aircraft"] as const,
    stagingMovePresets: () => ["tower", "staging-move-presets"] as const,
    viewStreams: () => ["tower", "view-streams"] as const,
    vesselSchematic: (sessionId: string) =>
      ["tower", "vessel-schematic", sessionId] as const
  }
};
