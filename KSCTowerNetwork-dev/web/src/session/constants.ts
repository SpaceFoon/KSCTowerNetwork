/**
 * Shared with chat + voice + the App-level `useActiveRoom` poll so the same
 * session id is used across desks. Server-truth ownership: this value is
 * written by `useActiveRoom` from `GET /v1/me/active-room` and read by the
 * desks on render — clients should not write it directly outside the lobby's
 * "Join room" / "Create room" flow.
 */
export const SESSION_STORAGE_KEY = "ksc_tower_chat_session_id";

/**
 * @deprecated The frontend no longer falls back to `dev-shared` anywhere — the
 * /tower route is gated on a real server-side session, and the topbar reflects
 * that. Kept exported as a documented historical bootstrap id (the backend
 * filters it out of the lobby room list and the KSP plugin still references
 * it for offline/dev mode), but no SPA code path should use it as a default.
 */
export const DEFAULT_DEV_SESSION_ID = "dev-shared";
