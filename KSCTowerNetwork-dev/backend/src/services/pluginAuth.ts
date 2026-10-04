import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { getRedis } from "../lib/redis";

interface ExchangeCodeRecord {
  userId: string;
  expiresAtMs: number;
}

const exchangeCodes = new Map<string, ExchangeCodeRecord>();
const EXCHANGE_TTL_MS = 5 * 60 * 1000;
const REDIS_PREFIX = "auth:plugin:exchange:";
const ISSUE_MAX_ATTEMPTS = 4;

export async function issueExchangeCode(userId: string): Promise<{ code: string; expiresInSeconds: number }> {
  const expiresInSeconds = Math.floor(EXCHANGE_TTL_MS / 1000);

  let lastCode = "";
  let usingRedis = true;
  let redis: ReturnType<typeof getRedis> | undefined;
  try {
    redis = getRedis();
  } catch {
    usingRedis = false;
  }

  for (let attempt = 0; attempt < ISSUE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomBytes(12).toString("hex");
    lastCode = code;

    if (!usingRedis || !redis) {
      // Pure-memory path: Map.set is unconditional, so a duplicate would silently
      // overwrite. Check first to avoid clobbering an outstanding code.
      if (!exchangeCodes.has(code)) {
        exchangeCodes.set(code, { userId, expiresAtMs: Date.now() + EXCHANGE_TTL_MS });
        return { code, expiresInSeconds };
      }
      continue;
    }

    try {
      // ioredis returns "OK" on success and `null` when NX is rejected because the key
      // already exists. The previous code did not check the reply, so on a (very rare)
      // collision the code was returned to the caller without ever being stored,
      // which made the subsequent /v1/auth/plugin/exchange always 401.
      // eslint-disable-next-line no-await-in-loop
      const reply = await redis.set(
        `${REDIS_PREFIX}${code}`,
        userId,
        "EX",
        expiresInSeconds,
        "NX"
      );
      if (reply === "OK") {
        return { code, expiresInSeconds };
      }
      logger.warn({ attempt }, "Plugin exchange code collision; retrying");
    } catch (error) {
      // Redis became unreachable mid-loop. Fall through to in-memory storage.
      logger.warn({ err: error }, "Redis SET failed for plugin exchange code; falling back to memory");
      usingRedis = false;
      if (!exchangeCodes.has(code)) {
        exchangeCodes.set(code, { userId, expiresAtMs: Date.now() + EXCHANGE_TTL_MS });
        return { code, expiresInSeconds };
      }
    }
  }

  throw new Error(
    `Failed to issue plugin exchange code after ${ISSUE_MAX_ATTEMPTS} attempts (last=${lastCode.slice(0, 4)}...)`
  );
}

export async function exchangePluginToken(code: string): Promise<string | null> {
  let userId: string | undefined;
  try {
    const redis = getRedis();
    const key = `${REDIS_PREFIX}${code}`;
    const tx = redis.multi();
    tx.get(key);
    tx.del(key);
    const result = await tx.exec();
    const rawUserId = result?.[0]?.[1];
    if (typeof rawUserId === "string" && rawUserId) {
      userId = rawUserId;
    }
  } catch {
    const record = exchangeCodes.get(code);
    if (record) {
      exchangeCodes.delete(code);
      if (record.expiresAtMs >= Date.now()) {
        userId = record.userId;
      }
    }
  }

  if (!userId) {
    return null;
  }

  return jwt.sign(
    {
      token_type: "plugin_session"
    },
    env.APP_JWT_SECRET,
    {
      expiresIn: env.APP_JWT_EXPIRES_IN_SECONDS,
      subject: userId
    }
  );
}
