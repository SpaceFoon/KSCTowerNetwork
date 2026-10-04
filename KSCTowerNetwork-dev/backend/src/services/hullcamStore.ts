import { logger } from "../lib/logger";

/**
 * In-memory hot store for HullCam JPEG snapshots relayed from the pilot's KSP plugin.
 *
 * Frames are tiny (1–2 fps, ~20–60 KB each) and only meaningful while the pilot is in flight,
 * so we never persist them; losing this on backend restart is correct behavior — the plugin
 * will start pushing fresh frames within ~1 s of reconnecting.
 */

export interface HullCamFrame {
  /** Original JPEG bytes as posted by the pilot's plugin. Always present. */
  jpeg: Buffer;
  /** Display name from JRTI (e.g. "ServiceBay-Cam-2"). */
  name: string;
  updatedAtMs: number;
  /**
   * Lazily-populated, downscaled+mozjpeg-recompressed variant served to viewers
   * that don't accept WebP. Computed on first viewer GET (see snapshot route)
   * and reused by every subsequent viewer until the next frame replaces this
   * `HullCamFrame`. Stays undefined when nobody's watching.
   */
  optimizedJpeg?: Buffer;
  /** In-flight encode promise so concurrent viewers dedupe to a single sharp call. */
  optimizedJpegPromise?: Promise<Buffer>;
  /** Same as `optimizedJpeg` but for the WebP variant served to modern browsers. */
  webp?: Buffer;
  /** In-flight encode promise for the WebP variant. */
  webpPromise?: Promise<Buffer>;
  /**
   * Set to true if a previous re-encode threw (corrupt JPEG, sharp/libvips
   * busted, etc.) so we stop retrying on every poll and just serve the
   * original bytes. Reset on the next frame.
   */
  optimizationFailed?: boolean;
}

export interface HullCamCameraSummary {
  id: number;
  name: string;
  updatedAtMs: number;
}

/** Frames older than this are treated as gone (LOS in the tower UI). */
const STALE_MS = 10_000;
/** Sweeper cadence for evicting stale frames. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Hard cap on simultaneously-tracked sessions to prevent unbounded memory growth.
 * Worst-case memory at all caps maxed: MAX_SESSIONS * MAX_CAMERAS_PER_SESSION *
 * HULLCAM_MAX_BODY_BYTES (192 KB) ≈ 192 MB. Anything above that means we're being
 * abused and the eager eviction in `putFrame` kicks in.
 */
const MAX_SESSIONS = 128;
/**
 * Hard cap on cameras per session. Matches JRTI's `MaxOpenCameras` default (8) — an
 * honest pilot never has more than this on a craft. Cap was 16 historically; lowering
 * to the JRTI default removes the slack that a malicious client could fill.
 */
const MAX_CAMERAS_PER_SESSION = 8;

const store = new Map<string, Map<number, HullCamFrame>>();

let sweeperHandle: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeperHandle !== null) return;
  sweeperHandle = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      logger.warn({ err }, "hullcamStore sweep failed");
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive purely for this sweeper.
  sweeperHandle.unref?.();
}

function sweep(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [sid, cams] of store) {
    for (const [cid, frame] of cams) {
      if (frame.updatedAtMs < cutoff) {
        cams.delete(cid);
      }
    }
    if (cams.size === 0) {
      store.delete(sid);
    }
  }

  // If we somehow blew past the session cap (concurrent abuse), drop the oldest.
  if (store.size > MAX_SESSIONS) {
    const entries = [...store.entries()].map(([sid, cams]) => {
      let newest = 0;
      for (const f of cams.values()) {
        if (f.updatedAtMs > newest) newest = f.updatedAtMs;
      }
      return { sid, newest };
    });
    entries.sort((a, b) => a.newest - b.newest);
    const drop = entries.length - MAX_SESSIONS;
    for (let i = 0; i < drop; i++) {
      const e = entries[i];
      if (e) store.delete(e.sid);
    }
  }
}

export function putFrame(sessionId: string, cameraId: number, name: string, jpeg: Buffer): void {
  ensureSweeper();
  let cams = store.get(sessionId);
  if (!cams) {
    // Eagerly enforce the session cap on insert (not just lazily inside the 30 s
    // sweeper). Without this an authenticated attacker can transiently push us
    // far past MAX_SESSIONS during a flood, since the rate limiter allows 5
    // posts/sec/user and could create 150 sessions before the sweeper next runs.
    if (store.size >= MAX_SESSIONS) {
      evictOldestSession();
      if (store.size >= MAX_SESSIONS) {
        // Eviction failed (everything is fresh) — refuse the new session rather
        // than allow unbounded growth.
        return;
      }
    }
    cams = new Map();
    store.set(sessionId, cams);
  }
  // Reject new camera IDs once we're at the per-session cap, but always allow updates to
  // already-tracked cameras so a misbehaving pilot can't lock a real session out.
  if (!cams.has(cameraId) && cams.size >= MAX_CAMERAS_PER_SESSION) {
    return;
  }
  cams.set(cameraId, { jpeg, name, updatedAtMs: Date.now() });
}

/**
 * Drop the session whose newest frame is oldest (= least recently active).
 * Called from `putFrame` when a brand-new session id arrives and we're already
 * at MAX_SESSIONS so we don't have to wait 30 s for the sweeper.
 */
function evictOldestSession(): void {
  let victimSid: string | null = null;
  let victimNewest = Number.POSITIVE_INFINITY;
  for (const [sid, cams] of store) {
    let newest = 0;
    for (const f of cams.values()) {
      if (f.updatedAtMs > newest) newest = f.updatedAtMs;
    }
    if (newest < victimNewest) {
      victimNewest = newest;
      victimSid = sid;
    }
  }
  if (victimSid !== null) {
    store.delete(victimSid);
  }
}

export function getFrame(sessionId: string, cameraId: number): HullCamFrame | null {
  const cams = store.get(sessionId);
  if (!cams) return null;
  const frame = cams.get(cameraId);
  if (!frame) return null;
  if (Date.now() - frame.updatedAtMs > STALE_MS) {
    cams.delete(cameraId);
    if (cams.size === 0) store.delete(sessionId);
    return null;
  }
  return frame;
}

export function listCameras(sessionId: string): HullCamCameraSummary[] {
  const cams = store.get(sessionId);
  if (!cams) return [];
  const cutoff = Date.now() - STALE_MS;
  const out: HullCamCameraSummary[] = [];
  for (const [id, frame] of cams) {
    if (frame.updatedAtMs < cutoff) continue;
    out.push({ id, name: frame.name, updatedAtMs: frame.updatedAtMs });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

export function dropSession(sessionId: string): void {
  store.delete(sessionId);
}

/**
 * Enumerate every session id that currently has at least one fresh frame in the
 * hot store, optionally filtered by a prefix. Used by the `tower/view-streams`
 * endpoint to surface live KSC-TOWER-* hullcam streams without a DB row backing
 * them — these "tower view" streams are intentionally session-rowless so they
 * never pollute lobby/queue/scoring.
 *
 * Stale frames are skipped using the same `STALE_MS` cut-off as `getFrame`.
 */
export function listActiveSessionIds(prefix?: string): string[] {
  const cutoff = Date.now() - STALE_MS;
  const out: string[] = [];
  for (const [sid, cams] of store) {
    if (prefix && !sid.startsWith(prefix)) continue;
    let anyFresh = false;
    for (const f of cams.values()) {
      if (f.updatedAtMs >= cutoff) {
        anyFresh = true;
        break;
      }
    }
    if (anyFresh) {
      out.push(sid);
    }
  }
  out.sort();
  return out;
}

/**
 * True when the session id matches the dedicated KSC tower view-stream
 * namespace. These ids are not backed by a `sessions` row — they're a thin
 * pass-through for hullcam JPEG frames so any signed-in pilot in flight at the
 * tower window can broadcast their hull-cam to other pilots' Tower View tile.
 *
 * Format: `KSC-TOWER-` followed by 1..40 chars of `[A-Za-z0-9_-]`. The cap
 * keeps URL/query budgets sane and blocks accidental injection of arbitrary
 * strings into the namespace.
 */
const KSC_TOWER_SESSION_RE = /^KSC-TOWER-[A-Za-z0-9_-]{1,40}$/;
export function isKscTowerSessionId(sessionId: string): boolean {
  return KSC_TOWER_SESSION_RE.test(sessionId);
}

export const KSC_TOWER_SESSION_PREFIX = "KSC-TOWER-";

export const HULLCAM_STALE_MS = STALE_MS;
