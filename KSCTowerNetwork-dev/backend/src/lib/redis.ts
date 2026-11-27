import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

let redis: IORedis | null = null;
/** Skip request-path Redis calls while unhealthy; a recovery loop clears this. */
let redisSkipped = false;
let redisGeneration = 0;
/** True while the recovery loop is probing; a failed probe is not a new outage. */
let redisProbing = false;

export function getRedisGeneration(): number {
  return redisGeneration;
}

export function getRedis(): IORedis {
  if (redisSkipped) {
    throw new Error("Redis unavailable");
  }
  if (redis) {
    return redis;
  }

  const client = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => undefined,
    reconnectOnError: () => false
  });

  // ioredis emits "error" on failed connect and on lost connections. Retries are off, so a
  // runtime error must switch to the fallback here: the recovery loop only probes while
  // redisSkipped is set, and without this a disconnect after startup is never recovered.
  client.on("error", (error) => {
    if (redis === client) {
      // A failed recovery probe must not bump the generation: that would reset rate-limit
      // counters every probe interval for as long as Redis stays down.
      markRedisUnavailable(error, !redisProbing);
    }
  });
  redis = client;

  return client;
}

function redisErrorHint(error: unknown): string {
  return error instanceof Error && error.message.includes("ECONNREFUSED")
    ? "nothing listening on REDIS_URL (often 127.0.0.1:6379)"
    : error instanceof Error
      ? error.message
      : String(error);
}

export function markRedisUnavailable(error: unknown, bumpGeneration = true): void {
  redisSkipped = true;
  if (bumpGeneration) {
    redisGeneration += 1;
  }
  if (redis) {
    try {
      redis.disconnect(false);
    } catch {
      /* ignore */
    }
    redis = null;
  }
  logger.info(
    "Redis not used - in-memory queue only (%s). Normal for local dev without Redis.",
    redisErrorHint(error)
  );
}

export async function pingRedis(options: { bumpGenerationOnFailure?: boolean } = {}): Promise<boolean> {
  if (redisSkipped) {
    return false;
  }
  try {
    const client = getRedis();
    await client.connect();
    await client.ping();
    return true;
  } catch (error) {
    markRedisUnavailable(error, options.bumpGenerationOnFailure ?? true);
    return false;
  }
}

export function startRedisRecovery(options: {
  intervalMs?: number;
  onRecovered?: () => Promise<void> | void;
} = {}): () => void {
  const intervalMs = Math.max(1000, options.intervalMs ?? 10_000);
  let recovering = false;
  const timer = setInterval(() => {
    if (recovering || !redisSkipped) return;
    recovering = true;
    void (async () => {
      try {
        redisSkipped = false;
        redisProbing = true;
        let ok: boolean;
        try {
          ok = await pingRedis({ bumpGenerationOnFailure: false });
        } finally {
          redisProbing = false;
        }
        if (!ok) return;
        redisGeneration += 1;
        logger.info("Redis recovered; re-enabling Redis-backed services");
        await options.onRecovered?.();
      } catch (error) {
        markRedisUnavailable(error);
      } finally {
        recovering = false;
      }
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
