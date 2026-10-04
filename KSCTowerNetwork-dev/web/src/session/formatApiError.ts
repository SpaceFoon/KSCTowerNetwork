export type ApiErrorContext =
  | "messages"
  | "session"
  | "send"
  | "livekit"
  | "rotate"
  | "dm"
  | "handoff";

/**
 * Human-readable copy for common API failures (session/chat/voice).
 */
export function formatApiError(status: number, message: string, context: ApiErrorContext): string {
  const m = message.trim();

  if (status === 404) {
    if (context === "messages" || context === "session" || context === "send") {
      return `No session with this id. Go back to the Lobby and join (or create) a tower room. (${m})`;
    }
    if (context === "rotate") {
      return `That session no longer exists, so the tower could not be rotated. (${m})`;
    }
    return `${m}`;
  }

  if (status === 403) {
    if (m.includes("Not authorized for this session") || m.includes("Banned users")) {
      return `You cannot access this session with the current account (wrong role, or not the pilot / assigned tower). ${m}`;
    }
    if (m.includes("Not authorized for this room")) {
      return `Voice: your account cannot join this room’s audio. You must be the pilot or assigned tower to listen; publishing needs pilot or tower. Clerk-signed users may listen only. ${m}`;
    }
    if (m.includes("rotate tower")) {
      return `Only the pilot, assigned tower, or an admin can hand off to the next tower operator. ${m}`;
    }
    return m;
  }

  if (status === 503 && (context === "livekit" || m.includes("LiveKit"))) {
    return `Voice is unavailable: the backend is not configured for LiveKit (set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL). ACARS text may still work. (${m})`;
  }

  if (status === 401 || status === 403) {
    if (context === "send" && m.length < 80) {
      return `Request was rejected (${status}): ${m}. If you use dev mode, ensure the backend accepts your token.`;
    }
  }

  return m;
}
