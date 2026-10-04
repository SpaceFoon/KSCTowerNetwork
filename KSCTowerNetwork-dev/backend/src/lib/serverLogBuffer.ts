/**
 * In-memory ring buffer of recent backend log lines so the admin SPA can tail
 * them via `GET /v1/admin/server-logs` without us having to ship a separate
 * log shipper. Pino writes NDJSON into `recordLogLine()` (see logger.ts), we
 * parse each line into a structured record, and discard the oldest when the
 * buffer fills.
 *
 * This is intentionally process-local: it survives nothing — restart wipes
 * everything. For prod log shipping, point pino at a real sink in addition
 * to this buffer.
 */
import { Writable } from "node:stream";

export type ServerLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type ServerLogEntry = {
  /** Monotonic id assigned at insert time so the SPA can dedupe across polls. */
  seq: number;
  /** ISO timestamp of the log line. */
  at: string;
  /** Lowercased pino level name. Falls back to "info" for non-numeric inputs. */
  level: ServerLogLevel;
  /** The `msg` field (or stringified line if pino didn't emit one). */
  msg: string;
  /** Optional pino logger name. */
  name?: string;
  /** Process pid; helps when running multiple workers behind a load balancer. */
  pid?: number;
  /** Hostname pino tags onto every record by default. */
  hostname?: string;
  /** Everything else pino emitted on this record (request, error, custom keys). */
  meta?: Record<string, unknown>;
};

const MAX_ENTRIES = 1000;
const PINO_LEVEL_TO_NAME: Record<number, ServerLogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

const buffer: ServerLogEntry[] = [];
let nextSeq = 1;

/**
 * Parse a single NDJSON line emitted by pino and append the resulting entry to
 * the ring buffer. Tolerant of partial / non-JSON input — those are stored as
 * `info` lines with the raw text so nothing slips silently past an admin tail.
 */
export function recordLogLine(rawLine: string): void {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let entry: ServerLogEntry;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const levelNum = typeof parsed.level === "number" ? parsed.level : 30;
    const timeNum = typeof parsed.time === "number" ? parsed.time : Date.now();
    const {
      level: _level,
      time: _time,
      msg,
      name,
      pid,
      hostname,
      ...rest
    } = parsed;
    entry = {
      seq: nextSeq++,
      at: new Date(timeNum).toISOString(),
      level: PINO_LEVEL_TO_NAME[levelNum] ?? "info",
      msg: typeof msg === "string" ? msg : "",
      name: typeof name === "string" ? name : undefined,
      pid: typeof pid === "number" ? pid : undefined,
      hostname: typeof hostname === "string" ? hostname : undefined,
      meta: Object.keys(rest).length > 0 ? rest : undefined
    };
  } catch {
    entry = {
      seq: nextSeq++,
      at: new Date().toISOString(),
      level: "info",
      msg: trimmed
    };
  }

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

/**
 * Read the most recent `limit` entries (default 200), optionally only those
 * with `seq > sinceSeq` so a polling client can fetch deltas. Sorted oldest-
 * to-newest so the SPA can append directly to its own tail.
 */
export function readLogEntries(opts: {
  limit?: number;
  sinceSeq?: number;
  minLevel?: ServerLogLevel;
} = {}): { entries: ServerLogEntry[]; latestSeq: number; capacity: number } {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_ENTRIES));
  const sinceSeq = opts.sinceSeq ?? 0;
  const minRank = opts.minLevel ? LEVEL_RANK[opts.minLevel] : 0;

  // Walk from the tail so we can stop once we've collected `limit` matches
  // without scanning the whole 1000-entry buffer for noisy filters.
  const collected: ServerLogEntry[] = [];
  for (let i = buffer.length - 1; i >= 0 && collected.length < limit; i--) {
    const entry = buffer[i]!;
    if (entry.seq <= sinceSeq) break;
    if (minRank > 0 && LEVEL_RANK[entry.level] < minRank) continue;
    collected.push(entry);
  }
  collected.reverse();

  const latestSeq = buffer.length > 0 ? buffer[buffer.length - 1]!.seq : 0;
  return { entries: collected, latestSeq, capacity: MAX_ENTRIES };
}

const LEVEL_RANK: Record<ServerLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
};

/**
 * Writable stream pino can target via `pino.multistream()`. Splits incoming
 * chunks on newlines so a partial flush doesn't shred a JSON record across
 * two buffer entries.
 */
export const serverLogStream = new Writable({
  write(chunk: Buffer | string, _enc, cb) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line) recordLogLine(line);
    }
    cb();
  }
});

/** Test-only: wipe the buffer so unit tests don't see leftover entries. */
export function __resetServerLogBufferForTests(): void {
  buffer.length = 0;
  nextSeq = 1;
}
