import { isIP } from "node:net";

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

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const version = isIP(normalized);
  if (version === 4) return Number(normalized.split(".", 1)[0]) === 127;
  if (version === 6) {
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    return mapped ? isLoopbackHost(mapped[1]) : false;
  }
  return false;
}

/** Reject unauthenticated bridge listeners on network interfaces by default. */
export function assertSafeBridgeBindHosts(
  hosts: { pcmHost: string; ctlHost: string },
  allowNonLoopback: boolean
): string[] {
  const nonLoopback = Object.entries(hosts)
    .filter(([, host]) => !isLoopbackHost(host))
    .map(([name, host]) => `${name === "pcmHost" ? "PCM_HOST" : "CTL_HOST"}=${host}`);
  if (nonLoopback.length > 0 && !allowNonLoopback) {
    throw new Error(
      `Refusing to bind voice bridge on non-loopback host(s): ${nonLoopback.join(", ")}. Set ALLOW_NON_LOOPBACK_BIND=1 only on a trusted private network.`
    );
  }
  return nonLoopback;
}
