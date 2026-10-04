import { timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { findCredentialByEmail, listRegisteredUsers } from "./registeredUsers";

/**
 * Roles a web user is allowed to be configured with. Mirrors `Role` in
 * `repository.ts` but inlined here to avoid a circular import (repository
 * imports from this file to seed roles at startup).
 */
const WEB_ROLE_VALUES = ["guest", "pilot", "controller", "mod", "supermod", "owner"] as const;
type WebRole = (typeof WEB_ROLE_VALUES)[number];

function isWebRole(value: unknown): value is WebRole {
  return typeof value === "string" && (WEB_ROLE_VALUES as readonly string[]).includes(value);
}

export type WebAuthUser = {
  userId: string;
  email: string;
  /**
   * Explicit role for this user. There is intentionally no default. If you
   * add a user to WEB_LOGIN_USERS_JSON you MUST pick their role; we'd rather
   * the entry fail to parse than silently land them on `pilot` and confuse
   * the operator about why the wrong UI shows up.
   */
  role: WebRole;
};

const DEFAULT_WEB_LOGIN_EMAIL = "tower@ksc.local";
const DEFAULT_WEB_LOGIN_PASSWORD = "tower12345";
export const DEFAULT_WEB_LOGIN_USER_ID = "tower_local";
const WEB_TOKEN_TYPE = "tower_web";

let warnedAboutMissingUsers = false;
let warnedAboutDefaultUser = false;
let warnedAboutInvalidRoles = new Set<string>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeStringCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function defaultUserAllowed(): boolean {
  return env.DEV_DEFAULT_WEB_USER && env.NODE_ENV !== "production";
}

function builtinDevWebUser(): WebAuthUser {
  // The built-in tower account inherits whatever DEV_USER_ROLE is set to so
  // signing in as "tower" gives you the role you asked for in .env.development
  // (controller / owner / etc.), not a silent `pilot` default.
  return {
    userId: DEFAULT_WEB_LOGIN_USER_ID,
    email: DEFAULT_WEB_LOGIN_EMAIL,
    role: env.DEV_USER_ROLE
  };
}

/**
 * Parses WEB_LOGIN_USERS_JSON. Entries with missing/invalid `role` are SKIPPED
 * with a warning rather than coerced to `pilot`. Returning a partial list is
 * the right call here: the operator gets a loud one-time warning naming the
 * bad entry, and only the well-formed users can sign in. Silently defaulting
 * is the bug we're trying to kill.
 */
function readConfiguredUsers(): WebAuthUser[] {
  const raw = process.env.WEB_LOGIN_USERS_JSON;
  if (!raw?.trim()) {
    if (defaultUserAllowed()) {
      if (!warnedAboutDefaultUser) {
        warnedAboutDefaultUser = true;
        logger.warn(
          { email: DEFAULT_WEB_LOGIN_EMAIL, role: env.DEV_USER_ROLE },
          "DEV_DEFAULT_WEB_USER=1 is enabling the built-in dev login. Do not use in production."
        );
      }
      return [builtinDevWebUser()];
    }
    if (!warnedAboutMissingUsers) {
      warnedAboutMissingUsers = true;
      logger.warn(
        "WEB_LOGIN_USERS_JSON is not set. /v1/auth/login will reject all attempts. " +
          "Set WEB_LOGIN_USERS_JSON or (in dev only) DEV_DEFAULT_WEB_USER=1."
      );
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error({ err }, "WEB_LOGIN_USERS_JSON is not valid JSON; rejecting all web logins.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error("WEB_LOGIN_USERS_JSON must be a JSON array; rejecting all web logins.");
    return [];
  }

  const users: WebAuthUser[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const userId = typeof e.userId === "string" ? e.userId.trim() : "";
    const email = typeof e.email === "string" ? normalizeEmail(e.email) : "";
    if (!userId || !email) continue;

    if (!isWebRole(e.role)) {
      if (!warnedAboutInvalidRoles.has(userId)) {
        warnedAboutInvalidRoles.add(userId);
        logger.error(
          { userId, email, providedRole: e.role, validRoles: WEB_ROLE_VALUES },
          "WEB_LOGIN_USERS_JSON entry has missing or invalid 'role'; entry will be REJECTED. " +
            "Add an explicit role (guest|pilot|controller|mod|supermod|owner) to the entry."
        );
      }
      continue;
    }

    users.push({ userId, email, role: e.role });
  }
  return users;
}

type StoredCredential =
  | { kind: "argon2"; hash: string }
  | { kind: "plaintext"; password: string };

let warnedAboutPlaintextPasswords = new Set<string>();

/**
 * Look up the credential for an email, preferring `passwordHash` (argon2 PHC string)
 * over `password` (plaintext). Plaintext is still accepted for backward compat
 * but emits a one-time warning per email so operators get nudged to migrate.
 *
 * Generate hashes with `argon2.hash(plaintext, { type: argon2.argon2id })` —
 * the resulting PHC string starts with `$argon2id$...` and goes straight into
 * the `passwordHash` field of WEB_LOGIN_USERS_JSON.
 */
function credentialForEmail(email: string): StoredCredential | null {
  const normalized = normalizeEmail(email);
  const raw = process.env.WEB_LOGIN_USERS_JSON;
  if (!raw?.trim()) {
    if (!defaultUserAllowed()) {
      return null;
    }
    return normalized === DEFAULT_WEB_LOGIN_EMAIL
      ? { kind: "plaintext", password: DEFAULT_WEB_LOGIN_PASSWORD }
      : null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const candidateEmail = typeof e.email === "string" ? normalizeEmail(String(e.email)) : "";
      if (candidateEmail !== normalized) continue;

      const hash = typeof e.passwordHash === "string" ? String(e.passwordHash).trim() : "";
      if (hash) {
        return { kind: "argon2", hash };
      }
      const plain = typeof e.password === "string" ? String(e.password) : "";
      if (plain) {
        if (!warnedAboutPlaintextPasswords.has(normalized)) {
          warnedAboutPlaintextPasswords.add(normalized);
          logger.warn(
            { email: normalized },
            "WEB_LOGIN_USERS_JSON entry uses plaintext 'password'; migrate to 'passwordHash' " +
              "(argon2id PHC string). Generate with: " +
              `node -e "import('argon2').then(a=>a.hash('YOUR_PASSWORD',{type:a.argon2id}).then(console.log))"`
          );
        }
        return { kind: "plaintext", password: plain };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Default display name for web/KSP when the user leaves the field blank: email local-part, max 120 chars. */
export function resolveWebSessionDisplayName(email: string, requested?: string | null): string {
  const raw = (requested ?? "").trim();
  if (raw.length > 0) {
    return raw.length > 120 ? raw.slice(0, 120) : raw;
  }
  const em = email.trim().toLowerCase();
  const at = em.indexOf("@");
  const local = at > 0 ? em.slice(0, at) : em;
  const pilot = local.trim();
  return pilot.length > 120 ? pilot.slice(0, 120) : pilot;
}

export async function authenticateWebUser(email: string, password: string): Promise<WebAuthUser | null> {
  const normalized = normalizeEmail(email);
  const configuredUsers = readConfiguredUsers();
  const envCandidate = configuredUsers.find((u) => u.email === normalized);
  if (envCandidate) {
    const stored = credentialForEmail(normalized);
    if (!stored) {
      return null;
    }
    if (stored.kind === "argon2") {
      try {
        const ok = await argon2.verify(stored.hash, password);
        return ok ? envCandidate : null;
      } catch (err) {
        logger.error(
          { email: normalized, err: err instanceof Error ? err.message : String(err) },
          "argon2.verify failed (likely malformed passwordHash)"
        );
        return null;
      }
    }
    return safeStringCompare(password, stored.password) ? envCandidate : null;
  }

  // Fall through to the self-serve register store. Env-configured users always
  // win on email collision because they're operator-managed; we only consult
  // the register store when the env list has nothing for this address.
  const registered = findCredentialByEmail(normalized);
  if (registered) {
    try {
      const ok = await argon2.verify(registered.passwordHash, password);
      return ok
        ? { userId: registered.userId, email: registered.email, role: registered.role }
        : null;
    } catch (err) {
      logger.error(
        { email: normalized, err: err instanceof Error ? err.message : String(err) },
        "argon2.verify failed for registered user (corrupt hash)"
      );
      return null;
    }
  }

  // Unknown email path: run a dummy argon2 verify so the per-request CPU cost
  // is the same whether or not the email exists. Defends the login path
  // against email enumeration via timing.
  try {
    await argon2.verify(
      "$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$dGltaW5nc2FmZXBhZGRpbmdoZXJl",
      password
    );
  } catch {
    /* expected — this is purely a CPU-time padding */
  }
  return null;
}

/**
 * Returns every configured web user with their explicit role. Called once at
 * server boot to seed `localUserRoles` so `getUserAccess` never has to guess.
 *
 * Includes both env-managed (`WEB_LOGIN_USERS_JSON`) and self-serve
 * (`registeredUsers`) accounts. Env entries take precedence on email collision
 * — same rule as `authenticateWebUser`.
 */
export function listConfiguredWebUsers(): WebAuthUser[] {
  const envUsers = readConfiguredUsers();
  const seenIds = new Set(envUsers.map((u) => u.userId));
  const seenEmails = new Set(envUsers.map((u) => u.email));
  const merged: WebAuthUser[] = [...envUsers];
  for (const r of listRegisteredUsers()) {
    if (seenIds.has(r.userId) || seenEmails.has(r.email)) continue;
    merged.push({ userId: r.userId, email: r.email, role: r.role });
  }
  return merged;
}

export function issueWebSessionToken(user: WebAuthUser, resolvedDisplayName: string): string {
  return jwt.sign(
    {
      token_type: WEB_TOKEN_TYPE,
      email: user.email,
      display_name: resolvedDisplayName
    },
    env.APP_JWT_SECRET,
    {
      subject: user.userId,
      expiresIn: env.APP_JWT_EXPIRES_IN_SECONDS
    }
  );
}
