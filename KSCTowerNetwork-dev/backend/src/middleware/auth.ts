import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "@clerk/backend";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { SESSION_COOKIE_NAME } from "./csrf";
import {
  capabilitiesFor,
  ensureLocalRoleSeeded,
  getGuestById,
  getUserAccess,
  isIpBanned,
  isOwnerImmuneId,
  roleAtLeast,
  ROLE_RANK,
  type Capability,
  type Role
} from "../services/repository";

function isDevOpenAuth(): boolean {
  return (env.NODE_ENV === "development" || env.NODE_ENV === "test") && env.DEV_OPEN_AUTH;
}

/**
 * Per-IP record of the last plugin_session userId we saw, used by the dev-mode
 * identity bridge in `requireAuth`.
 *
 * Without this, dev open-auth makes every web request resolve to
 * `DEV_USER_ID="dev_local"`, while the in-game plugin sends a real
 * `plugin_session` JWT with `sub=<real Tower userId>`. The room a pilot creates
 * in-game (`pilotUserId = real userId`) then looks like "not yours" to their
 * own browser (`callerUserId = "dev_local"`), so `/v1/me/active-room` returns
 * null and the lobby card's only join affordance is "spectate".
 *
 * The bridge: when a request authed as plugin_session comes in, we remember
 * `ip → { userId, expiresAtMs }`. When a later request with no credential
 * (the typical dev browser case) lands and DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN is
 * on, we stamp the plugin's userId instead of `DEV_USER_ID` for the same IP.
 *
 * Production is unaffected because DEV_OPEN_AUTH is forbidden there. The map
 * is bounded (we evict on read when the entry is stale, and the cap below
 * prevents unbounded growth from a hostile crawler hitting many spoofed IPs).
 */
type PluginIdentitySeen = { userId: string; expiresAtMs: number };
const pluginIdentityByIp = new Map<string, PluginIdentitySeen>();
const PLUGIN_IDENTITY_BRIDGE_MAX_IPS = 256;

function rememberPluginIdentity(ip: string, userId: string): void {
  if (!ip || !userId) return;
  if (!isDevOpenAuth() || !env.DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN) return;
  const ttlMs = Math.max(1000, env.DEV_OPEN_AUTH_BRIDGE_TTL_SECONDS * 1000);
  pluginIdentityByIp.set(ip, { userId, expiresAtMs: Date.now() + ttlMs });

  // Cheap LRU-ish trim: oldest insertion order entries (Map preserves insertion
  // order) get dropped when we exceed the cap. Avoids growth from a script
  // pounding the API with many spoofed plugin_session JWTs.
  if (pluginIdentityByIp.size > PLUGIN_IDENTITY_BRIDGE_MAX_IPS) {
    const overflow = pluginIdentityByIp.size - PLUGIN_IDENTITY_BRIDGE_MAX_IPS;
    let dropped = 0;
    for (const key of pluginIdentityByIp.keys()) {
      if (dropped >= overflow) break;
      pluginIdentityByIp.delete(key);
      dropped++;
    }
  }
}

function lookupPluginIdentity(ip: string): string | undefined {
  if (!ip) return undefined;
  if (!isDevOpenAuth() || !env.DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN) return undefined;
  const entry = pluginIdentityByIp.get(ip);
  if (!entry) return undefined;
  if (entry.expiresAtMs < Date.now()) {
    pluginIdentityByIp.delete(ip);
    return undefined;
  }
  return entry.userId;
}

/** Test-only: clear the dev-mode identity bridge so cases don't leak into one another. */
export function __resetPluginIdentityBridgeForTests(): void {
  pluginIdentityByIp.clear();
}

function bearerMatchesDevSecret(token: string): boolean {
  const secret = env.DEV_BEARER_SECRET;
  if (!secret || (env.NODE_ENV !== "development" && env.NODE_ENV !== "test")) {
    return false;
  }
  if (token.length !== secret.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(secret, "utf8"));
  } catch {
    return false;
  }
}

export type AppBearerAuth = {
  userId: string;
  tokenType: "plugin" | "clerk" | "guest";
  authSource: "bearer";
  ip: string;
  email?: string;
  displayName?: string;
};

/**
 * Lightweight bearer-token authenticator for non-Express transports (UDP/WS).
 * Accepts app-issued JWTs (`plugin_session`, `tower_web`, `guest`) and returns
 * the same identity shape `requireAuth` would stamp onto `req.auth`.
 */
export async function authenticateAppBearerToken(token: string, ip = ""): Promise<AppBearerAuth | null> {
  if (!token) return null;
  try {
    const appPayload = jwt.verify(token, env.APP_JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (appPayload?.sub && appPayload.token_type === "plugin_session") {
      rememberPluginIdentity(ip, appPayload.sub);
      return { userId: appPayload.sub, tokenType: "plugin", authSource: "bearer", ip };
    }
    if (appPayload?.sub && appPayload.token_type === "tower_web") {
      const dn = (appPayload as jwt.JwtPayload & { display_name?: unknown }).display_name;
      const displayName = typeof dn === "string" && dn.trim().length > 0 ? dn.trim() : undefined;
      return {
        userId: appPayload.sub,
        tokenType: "clerk",
        authSource: "bearer",
        email: typeof appPayload.email === "string" ? appPayload.email : undefined,
        displayName,
        ip
      };
    }
    if (appPayload?.sub && appPayload.token_type === "guest") {
      const guest = await getGuestById(appPayload.sub);
      if (!guest) return null;
      const dn = (appPayload as jwt.JwtPayload & { display_name?: unknown }).display_name;
      const displayName = typeof dn === "string" && dn.trim().length > 0 ? dn.trim() : undefined;
      return {
        userId: appPayload.sub,
        tokenType: "guest",
        authSource: "bearer",
        displayName,
        ip
      };
    }
  } catch {
    return null;
  }
  return null;
}

function extractBearer(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

/** Pull the session JWT out of the HttpOnly cookie set on /v1/auth/login. */
function extractSessionCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[SESSION_COOKIE_NAME];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Resolve credential + source. Prefers the Authorization header (KSP plugin,
 * voice bridge, dev curl) and falls back to the session cookie used by the web
 * UI. The cookie path drives `authSource: "cookie"`, which `csrfGuard` keys off
 * to require X-CSRF-Token on mutations.
 */
function extractCredential(
  req: Request
): { token: string; source: "bearer" | "cookie" } | undefined {
  const bearer = extractBearer(req);
  if (bearer) return { token: bearer, source: "bearer" };
  const cookie = extractSessionCookie(req);
  if (cookie) return { token: cookie, source: "cookie" };
  return undefined;
}

function clientIp(req: Request): string {
  // Express's `req.ip` honors `trust proxy`. Fall back to socket address only if missing.
  return req.ip ?? req.socket?.remoteAddress ?? "";
}

const DEV_VOICE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * IP-level deny-list. Runs before `requireAuth` so a banned guest IP can't even reach
 * `POST /v1/guest/session` to mint a fresh identity.
 */
export async function loadIpBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = clientIp(req);
  if (await isIpBanned(ip)) {
    res.status(403).json({ error: "Banned from service", reason: "ip_banned" });
    return;
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = clientIp(req);

  if (isDevOpenAuth()) {
    req.auth = { userId: env.DEV_USER_ID, tokenType: "clerk", authSource: "dev-open", ip };
    // A valid `tower_web` JWT (in either Authorization header or session
    // cookie) wins over DEV_USER_ID even in dev-open mode. Without this,
    // logging into the web UI as pilot@ksc.local would still execute every
    // API call as DEV_USER_ID — making per-role testing impossible. We also
    // accept plugin_session here so a stray plugin call routed through the
    // dev open-auth path (e.g. the voice bridge during a local probe) keeps
    // its real identity instead of becoming "dev_local".
    const cred = extractCredential(req);
    if (cred) {
      try {
        const payload = jwt.verify(cred.token, env.APP_JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
        if (payload?.sub && payload.token_type === "tower_web") {
          const dn = (payload as jwt.JwtPayload & { display_name?: unknown }).display_name;
          const displayName = typeof dn === "string" && dn.trim().length > 0 ? dn.trim() : undefined;
          req.auth = {
            userId: payload.sub,
            tokenType: "clerk",
            authSource: cred.source,
            email: typeof payload.email === "string" ? payload.email : undefined,
            displayName,
            ip
          };
          next();
          return;
        }
        if (payload?.sub && payload.token_type === "plugin_session") {
          rememberPluginIdentity(ip, payload.sub);
          req.auth = {
            userId: payload.sub,
            tokenType: "plugin",
            authSource: cred.source,
            ip
          };
          next();
          return;
        }
      } catch {
        // Not a web JWT (or expired) — fall through to header / bridge below.
      }
    }
    const headerName = env.DEV_VOICE_IDENTITY_HEADER?.trim().toLowerCase();
    if (headerName) {
      const raw = req.headers[headerName];
      const val = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
      if (val && DEV_VOICE_ID_RE.test(val)) {
        req.auth.userId = val;
        // Dev open-auth lets the voice bridge (and other local test
        // identities) introduce themselves via a header. Seed the role
        // explicitly here so getUserAccess() finds it instead of throwing
        // MissingUserRoleError. `pilot` is the minimum role with
        // `voice:speak`, which is exactly what the bridge needs.
        // This is dev-only — env.ts forbids DEV_VOICE_IDENTITY_HEADER in prod.
        ensureLocalRoleSeeded(val, "pilot");
        next();
        return;
      }
    }
    // Identity bridge: if the same IP recently presented a plugin_session JWT,
    // inherit its userId so the user's browser and their KSP plugin agree on
    // who they are. Only triggers when no other credential / header above
    // produced a real identity. See `pluginIdentityByIp` for the full why.
    const pluginUserId = lookupPluginIdentity(ip);
    if (pluginUserId && req.auth.userId === env.DEV_USER_ID) {
      req.auth = {
        userId: pluginUserId,
        tokenType: "clerk",
        authSource: "dev-open-bridged",
        ip
      };
    }
    next();
    return;
  }

  const cred = extractCredential(req);
  if (!cred) {
    res.status(401).json({ error: "Missing credential (bearer token or session cookie)" });
    return;
  }

  try {
    const appPayload = jwt.verify(cred.token, env.APP_JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (appPayload?.sub && appPayload.token_type === "plugin_session") {
      // Remember this plugin identity for the dev-mode browser-side bridge.
      // No-op outside dev (the helper checks the env flags itself).
      rememberPluginIdentity(ip, appPayload.sub);
      req.auth = { userId: appPayload.sub, tokenType: "plugin", authSource: cred.source, ip };
      next();
      return;
    }
    if (appPayload?.sub && appPayload.token_type === "tower_web") {
      const dn = (appPayload as jwt.JwtPayload & { display_name?: unknown }).display_name;
      const displayName = typeof dn === "string" && dn.trim().length > 0 ? dn.trim() : undefined;
      req.auth = {
        userId: appPayload.sub,
        tokenType: "clerk",
        authSource: cred.source,
        email: typeof appPayload.email === "string" ? appPayload.email : undefined,
        displayName,
        ip
      };
      next();
      return;
    }
    if (appPayload?.sub && appPayload.token_type === "guest") {
      // Server-side revocation check: a long-lived guest JWT must still map to
      // a known guests row. If a mod IP-bans the guest and removes the row,
      // every still-cached token for that subject is invalidated immediately
      // even though the JWT itself hasn't expired.
      const guest = await getGuestById(appPayload.sub);
      if (!guest) {
        res.status(401).json({ error: "Guest session no longer valid", reason: "guest_revoked" });
        return;
      }
      const dn = (appPayload as jwt.JwtPayload & { display_name?: unknown }).display_name;
      const displayName = typeof dn === "string" && dn.trim().length > 0 ? dn.trim() : undefined;
      req.auth = {
        userId: appPayload.sub,
        tokenType: "guest",
        authSource: cred.source,
        displayName,
        ip
      };
      next();
      return;
    }
  } catch {
    // Not an app-issued token; fall through to Clerk verification.
  }

  // Dev bearer secret only ever travels in the Authorization header. Refuse
  // a cookie-presented dev secret outright so a hostile site can't pin one.
  if (cred.source === "bearer" && bearerMatchesDevSecret(cred.token)) {
    req.auth = { userId: env.DEV_USER_ID, tokenType: "clerk", authSource: "bearer", ip };
    next();
    return;
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    res.status(401).json({
      error:
        "No auth configured. Enable DEV_OPEN_AUTH (default in dev), set DEV_BEARER_SECRET, or configure Clerk keys."
    });
    return;
  }

  try {
    const tokenResult = await verifyToken(cred.token, {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY
    });

    const data = (tokenResult as { data?: { sub?: string } }).data;
    const errors = (tokenResult as { errors?: unknown[] }).errors;

    if (errors?.length || !data?.sub) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }

    req.auth = { userId: data.sub, tokenType: "clerk", authSource: cred.source, ip };
    next();
  } catch {
    res.status(401).json({ error: "Token verification failed" });
  }
}

/**
 * Effective role and current sanction state for an authenticated request.
 * Guest tokens stay guest even if a stale role row exists; the configured
 * owner remains immune to account bans.
 */
async function effectiveAccess(req: Request): Promise<{ role: Role; isBanned: boolean }> {
  if (!req.auth?.userId) return { role: "guest", isBanned: false };
  if (isOwnerImmuneId(req.auth.userId)) return { role: "owner", isBanned: false };
  const access = await getUserAccess(req.auth.userId);
  return {
    role: req.auth.tokenType === "guest" ? "guest" : access.role,
    isBanned: access.isBanned
  };
}

export async function effectiveRole(req: Request): Promise<Role> {
  return (await effectiveAccess(req)).role;
}

export function requireRole(min: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const access = await effectiveAccess(req);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned", reason: "banned" });
      return;
    }
    const role = access.role;
    if (!roleAtLeast(role, min)) {
      res.status(403).json({ error: `Requires role ${min} or higher`, have: role, need: min });
      return;
    }
    next();
  };
}

export function requireCapability(cap: Capability) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const access = await effectiveAccess(req);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned", reason: "banned" });
      return;
    }
    const role = access.role;
    if (!capabilitiesFor(role).has(cap)) {
      res.status(403).json({ error: `Missing capability: ${cap}`, role });
      return;
    }
    next();
  };
}

/** Back-compat alias used by routes/api.ts; equivalent to requireRole("owner"). */
export const requireAdmin = requireRole("owner");

/** Resolve role flags for a userId. Returned shape kept stable for /auth/me consumers. */
export async function userRoleFlags(userId: string): Promise<{
  role: Role;
  rank: number;
  isAdmin: boolean;
  isTower: boolean;
  isMod: boolean;
  isOwner: boolean;
  isGuest: boolean;
  capabilities: Capability[];
}> {
  const access = await getUserAccess(userId);
  return {
    role: access.role,
    rank: ROLE_RANK[access.role],
    isOwner: access.role === "owner",
    isAdmin: roleAtLeast(access.role, "mod"),
    isTower: roleAtLeast(access.role, "controller"),
    isMod: roleAtLeast(access.role, "mod"),
    isGuest: access.role === "guest",
    capabilities: [...access.capabilities]
  };
}
