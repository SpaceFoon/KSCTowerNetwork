import express, { type Application, type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { initDbSchema, markDbUnavailable, pingDb, startDbRecovery } from "./lib/db";
import { httpRequestLogSilenced } from "./lib/httpRequestLogSilence";
import { logger } from "./lib/logger";
import { pingRedis, startRedisRecovery } from "./lib/redis";
import { apiRouter } from "./routes/api";
import { CSRF_HEADER_NAME } from "./middleware/csrf";
import { MissingUserRoleError, seedConfiguredWebUserRoles } from "./services/repository";
import { loadRegisteredUsers } from "./services/registeredUsers";
import { loadInviteCodes } from "./services/inviteCodes";
import { startAtisScheduler } from "./services/atis";

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function resolveCorsOrigins(): { allowList: string[]; allowLocalDev: boolean } {
  const raw = env.CORS_ORIGINS?.trim();
  if (raw) {
    return {
      allowList: raw.split(",").map((s) => s.trim()).filter(Boolean),
      allowLocalDev: false
    };
  }
  return { allowList: [], allowLocalDev: env.NODE_ENV !== "production" };
}

export type BuiltHttpApp = {
  app: Application;
  /** Stops ATIS background interval; call after integration tests. */
  dispose: () => void;
  dbConnected: boolean;
  redisConnected: boolean;
};

/**
 * Builds the full Express stack (same as production `index.ts`) without listening.
 * Used by integration tests (Supertest) and by the server entrypoint.
 */
export async function buildHttpApp(): Promise<BuiltHttpApp> {
  const app = express();

  const trustProxy = env.TRUST_PROXY;
  if (trustProxy === "true") {
    app.set("trust proxy", true);
  } else if (trustProxy === "false") {
    app.set("trust proxy", false);
  } else if (/^\d+$/.test(trustProxy)) {
    app.set("trust proxy", Number(trustProxy));
  } else {
    app.set("trust proxy", trustProxy);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'none'"],
          imgSrc: ["'self'"],
          frameAncestors: ["'none'"]
        }
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
      referrerPolicy: { policy: "no-referrer" }
    })
  );

  const { allowList, allowLocalDev } = resolveCorsOrigins();
  const allowAny = allowList.includes("*");
  if (allowAny && allowList.length > 1) {
    logger.warn("CORS_ORIGINS contains '*' — other entries will be ignored.");
  }
  if (env.NODE_ENV === "production" && (allowAny || allowLocalDev)) {
    throw new Error(
      "Refusing to start: production CORS must use an explicit allowlist (set CORS_ORIGINS), not '*' or loopback fallback."
    );
  }
  if (allowLocalDev) {
    logger.info(
      "CORS: dev mode, accepting any http(s)://localhost or 127.0.0.1 origin (any port). Cookies will be issued; set CORS_ORIGINS to lock this down."
    );
  }
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowAny) {
          callback(null, true);
          return;
        }
        if (allowList.includes(origin)) {
          callback(null, true);
          return;
        }
        if (allowLocalDev && LOCAL_DEV_ORIGIN_RE.test(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: !allowAny,
      allowedHeaders: ["Content-Type", "Authorization", CSRF_HEADER_NAME]
    })
  );
  app.use(cookieParser());
  const HEAVY_JSON_ROUTE_PREFIXES = ["/v1/world-inventory/", "/v1/world-maps/"];
  const globalJsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (HEAVY_JSON_ROUTE_PREFIXES.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }
    globalJsonParser(req, res, next);
  });
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => httpRequestLogSilenced(req)
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode })
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-csrf-token"]',
          'req.headers["x-ksc-voice-identity"]',
          'res.headers["set-cookie"]',
          "req.body.password",
          "req.body.passwordHash",
          "req.body.token",
          "req.body.code"
        ],
        censor: "[REDACTED]",
        remove: false
      },
      customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${req.url} ${res.statusCode} ${Math.round(responseTime)}ms`,
      customErrorMessage: (req, res, _err) => `${req.method} ${req.url} ${res.statusCode}`,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "debug";
      }
    })
  );

  app.use("/v1", apiRouter);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MissingUserRoleError) {
      logger.warn({ userId: err.userId }, "Authenticated subject has no role assigned");
      res.status(401).json({ error: "no_role_assigned", message: err.message, userId: err.userId });
      return;
    }
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : 500;
    if (status >= 400 && status < 500) {
      logger.warn(
        { method: req.method, url: req.url, status, type: e?.type, msg: e?.message },
        "Client error"
      );
      if (!res.headersSent) {
        res.status(status).json({ error: e?.message ?? "Bad request", reason: e?.type });
      }
      return;
    }
    logger.error({ err }, "Unhandled error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const dbOk = await pingDb();
  if (env.NODE_ENV === "production" && !dbOk) {
    throw new Error(
      "Refusing to start: NODE_ENV=production requires a reachable MariaDB (MARIADB_*). Fix connectivity or credentials, then restart."
    );
  }
  if (dbOk) {
    try {
      await initDbSchema();
    } catch (error) {
      if (env.NODE_ENV === "production") {
        logger.error({ err: error }, "MariaDB schema initialization failed");
        throw new Error(
          "Refusing to start: MariaDB schema initialization failed in production. See logs for details."
        );
      }
      logger.warn({ err: error }, "Failed to initialize DB schema; continuing with in-memory runtime");
      await markDbUnavailable(error, "MariaDB schema initialization failed");
    }
  }
  const redisOk = await pingRedis();
  if (env.NODE_ENV === "production" && !redisOk) {
    throw new Error(
      "Refusing to start: NODE_ENV=production requires a reachable Redis (REDIS_URL)."
    );
  }

  await loadRegisteredUsers();
  await loadInviteCodes();
  seedConfiguredWebUserRoles();

  const stopAtis = startAtisScheduler();
  const stopDbRecovery = startDbRecovery({
    onRecovered: async () => {
      await initDbSchema();
    }
  });
  const stopRedisRecovery = startRedisRecovery();

  return {
    app,
    dispose: () => {
      stopDbRecovery();
      stopRedisRecovery();
      stopAtis();
    },
    dbConnected: dbOk,
    redisConnected: redisOk
  };
}
