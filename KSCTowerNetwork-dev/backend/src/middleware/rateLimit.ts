import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getRedis, getRedisGeneration } from "../lib/redis";
import { logger } from "../lib/logger";

/**
 * Rate-limit knobs. Numbers chosen so an honest pilot/controller never trips them
 * but a runaway script does. See the table in `routes/api.ts` for the matrix.
 *
 * If Redis is reachable we share counters across instances; otherwise the limiter
 * falls back to per-process memory which is still useful for a single-box dev box.
 */

let warnedAboutRedis = false;

function buildStore(prefix: string): Options["store"] | undefined {
  try {
    const redis = getRedis();
    // RedisStore's constructor immediately fires loadIncrementScript via
    // sendCommand, so the ioredis client must already be connected. We only
    // call buildStore() after pingRedis() has settled (see lazyLimiter below);
    // if the ping failed, getRedis() throws and we fall through to memory.
    return new RedisStore({
      // ioredis's `call(...args)` happily takes `string[]` (rate-limit-redis
      // only ever passes strings) but its overload types accept the variadic
      // form, not a spread. The cast is the documented integration pattern.
      sendCommand: (...args: string[]) =>
        (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
          ...args
        ) as Promise<never>,
      prefix: `rl:${prefix}:`
    }) as unknown as Options["store"];
  } catch (err) {
    if (!warnedAboutRedis) {
      warnedAboutRedis = true;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Rate limiter Redis store unavailable; falling back to in-memory counters (single process only)"
      );
    }
    return undefined;
  }
}

/**
 * Per-IP key that funnels IPv6 addresses through the v8 helper so a single
 * /64 prefix can't sidestep the limit by varying its suffix.
 */
function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "unknown");
}

/**
 * Bucket key per authenticated user when available, falling back to client IP.
 * `req.auth.userId` is populated by `requireAuth` — for routes mounted before
 * auth (e.g. /v1/auth/login) we land on the IP path, which is the desired
 * behaviour for password-style brute-force throttling.
 */
function userOrIpKey(req: Request): string {
  return req.auth?.userId ?? ipKey(req);
}

/**
 * Build a middleware that lazily constructs the underlying express-rate-limit
 * instance on first request. We need this because route modules import the
 * limiters at module-load time, which is *before* `pingRedis()` runs in
 * `index.ts`. Building the RedisStore eagerly would crash with
 * `Stream isn't writeable` against the not-yet-connected ioredis client.
 */
function lazyLimiter(opts: {
  prefix: string;
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator?: (req: Request) => string;
}): RequestHandler {
  let inner: RequestHandler | undefined;
  let innerRedisGeneration = -1;
  return (req: Request, res: Response, next: NextFunction) => {
    const redisGeneration = getRedisGeneration();
    if (!inner || innerRedisGeneration !== redisGeneration) {
      inner = rateLimit({
        windowMs: opts.windowMs,
        limit: opts.limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        keyGenerator: opts.keyGenerator ?? userOrIpKey,
        handler: (_req, response) => {
          response.status(429).json({
            error: opts.message,
            reason: "rate_limited",
            retryAfterSeconds: Math.ceil(opts.windowMs / 1000)
          });
        },
        store: buildStore(opts.prefix),
        // We *intentionally* construct the limiter on first request so the Redis
        // store can be wired up after pingRedis() resolves. The validator below
        // logs a multi-screen ValidationError on every request otherwise; this
        // disables only that one check and leaves the rest of the validators on.
        // (The validate key is `creationStack`, not the error code itself —
        // using the ERR_ERL_… name causes ERR_ERL_UNKNOWN_VALIDATION spam *and*
        // leaves the original creation-in-handler warning still firing.)
        validate: { creationStack: false }
      });
      innerRedisGeneration = redisGeneration;
    }
    return inner(req, res, next);
  };
}

/** /auth/login & /auth/guest: 10/min per IP. Tight to throttle credential stuffing. */
export const authLimiter = lazyLimiter({
  prefix: "auth",
  windowMs: 60 * 1000,
  limit: 10,
  message: "Too many auth attempts; wait a minute and try again",
  keyGenerator: ipKey
});

/** Chat / DM / preview-event: 30 writes per 10 s per user. */
export const writeLimiter = lazyLimiter({
  prefix: "write",
  windowMs: 10 * 1000,
  limit: 30,
  message: "Sending too fast; slow down for a few seconds"
});

/** Telemetry hot path: 5 Hz close-approach cadence + headroom = 15/sec/user. */
export const telemetryLimiter = lazyLimiter({
  prefix: "telem",
  windowMs: 1000,
  limit: 15,
  message: "Telemetry posted too fast"
});

/** HullCam: 1 fps target → cap at 5/sec/user so a stuck loop can't flood. */
export const hullcamLimiter = lazyLimiter({
  prefix: "hullcam",
  windowMs: 1000,
  limit: 5,
  message: "HullCam frames posted too fast"
});

/** World-maps / world-inventory: heavy, low frequency. 6 publishes/min/user. */
export const heavyPublishLimiter = lazyLimiter({
  prefix: "heavy",
  windowMs: 60 * 1000,
  limit: 6,
  message: "Too many publish attempts; wait a minute and re-bake"
});

/** Plugin exchange code mint: 6/min/user. */
export const pluginExchangeLimiter = lazyLimiter({
  prefix: "plugexchg",
  windowMs: 60 * 1000,
  limit: 6,
  message: "Too many plugin exchange code requests"
});
