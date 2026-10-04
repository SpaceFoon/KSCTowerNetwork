import type { IncomingMessage } from "node:http";

/** Path for log filtering: prefer Express `originalUrl` so mounts don't strip `/v1`. */
function requestPath(req: IncomingMessage): string {
  const extended = req as IncomingMessage & { originalUrl?: string };
  const raw =
    typeof extended.originalUrl === "string" && extended.originalUrl.length > 0
      ? extended.originalUrl
      : (req.url ?? "");
  return raw.split("?")[0] ?? "";
}

/**
 * Skip pino-http access lines for hot paths (browser/KSP polling). Errors still log via handlers.
 * Set `LOG_LEVEL=debug` and adjust here if you need per-request traces for these routes.
 */
export function httpRequestLogSilenced(req: IncomingMessage): boolean {
  const method = req.method ?? "GET";
  const path = requestPath(req);

  if (path === "/v1/health") return true;

  if (method === "GET") {
    if (path === "/v1/lobby/rooms" || path === "/v1/lobby/messages") return true;
    if (path === "/v1/auth/me") return true;
    if (/^\/v1\/session\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/session\/[^/]+\/messages$/.test(path)) return true;
    if (/^\/v1\/session\/[^/]+\/scorecard$/.test(path)) return true;
    // ChecklistModal polls this every 6s as an SSE fallback; just as noisy as
    // /messages and pairs with the existing /session and /messages silencers
    // above. SSE itself is on /checklist/stream and stays loud on purpose.
    if (/^\/v1\/session\/[^/]+\/checklist$/.test(path)) return true;
    // DM polling: same 2-3s cadence as session messages, just as noisy.
    if (path === "/v1/dm/threads" || path === "/v1/dm/peers") return true;
    if (/^\/v1\/dm\/[^/]+\/messages$/.test(path)) return true;
    // TowerDesk widget polls (hullcam ~1s, world-maps/inventory on HMR/route load).
    if (/^\/v1\/hullcam\/[^/]+$/.test(path)) return true;
    // Snapshot fetches poll at ~1 Hz and intentionally return 503 ("LOS") whenever
    // the pilot pauses the game or a camera drops out — that's a normal steady state,
    // not a server bug, so we don't want pino-http stack-tracing every poll.
    if (/^\/v1\/hullcam\/[^/]+\/[^/]+\/snapshot\.jpg$/.test(path)) return true;
    if (/^\/v1\/world-maps\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/world-inventory\/[^/]+$/.test(path)) return true;
  }

  if (method === "POST" && /^\/v1\/telemetry\/[^/]+$/.test(path)) return true;
  // JPEG uploads from the game plugin (multi-cam × 1–2 Hz). 403/429 are normal when
  // auth/session/rate-limit doesn't line up — same noise profile as telemetry POST.
  if (method === "POST" && /^(\/v1)?\/hullcam\/[^/]+\/[^/]+$/.test(path)) return true;

  return false;
}
