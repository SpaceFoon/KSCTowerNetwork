/**
 * Pure helpers shared by the voice-bridge TCP control path and LiveKit token JSON parsing.
 */

/** POST URL for `…/session/:sessionId/livekit-token` (same shape as backend `apiRouter`). */
export function buildLiveKitTokenRequestUrl(apiBase: string, sessionId: string): string {
  const base = apiBase.trim().replace(/\/+$/, "");
  return `${base}/session/${encodeURIComponent(sessionId)}/livekit-token`;
}

/** `SESSION:<id>` after a line has been newline-split and trimmed. */
export function parseSessionTuneCommand(line: string): string | null {
  if (!line.startsWith("SESSION:")) return null;
  const id = line.slice("SESSION:".length).trim();
  return id.length > 0 ? id : null;
}

/** Validates `/livekit-token` JSON body after a successful HTTP status. */
export function readLiveKitTokenFromJsonBody(j: Record<string, unknown>): { token: string; wsUrl: string } {
  const token = j.token;
  const wsUrl = j.wsUrl;
  if (typeof token !== "string" || !token) {
    throw new Error(`livekit-token: missing token: ${JSON.stringify(j)}`);
  }
  if (typeof wsUrl !== "string" || !wsUrl) {
    throw new Error(`livekit-token: missing wsUrl: ${JSON.stringify(j)}`);
  }
  return { token, wsUrl };
}
