import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Self-serve account store. Backs `/v1/auth/register` and is consulted by
 * `webAuth.authenticateWebUser` after the env-configured `WEB_LOGIN_USERS_JSON`
 * users so the operator-managed list always wins on email collision.
 *
 * On-disk format is a JSON array of `StoredRegisteredUser` rows. The hash is
 * argon2id (PHC string); plaintext passwords are never persisted. The file is
 * (re)written atomically (temp + rename) on every mutation so a crash mid-write
 * cannot leave the catalog truncated.
 *
 * In-memory state is the source of truth at runtime — disk is purely a restore
 * point. This mirrors the rest of the backend's "in-memory + best-effort
 * persistence" pattern (see `repository.ts`'s local maps).
 */

const ROLE_VALUES = ["guest", "pilot", "controller", "mod", "supermod", "owner"] as const;
type StoredRole = (typeof ROLE_VALUES)[number];

function isStoredRole(value: unknown): value is StoredRole {
  return typeof value === "string" && (ROLE_VALUES as readonly string[]).includes(value);
}

export type RegisteredUser = {
  userId: string;
  email: string;
  displayName: string;
  role: StoredRole;
  createdAt: string;
};

type StoredRegisteredUser = RegisteredUser & {
  passwordHash: string;
};

/** Internal map keyed by lowercased email. Email is the natural unique key. */
const usersByEmail = new Map<string, StoredRegisteredUser>();
/** Reverse index for ban / role-seed lookups by id. */
const usersById = new Map<string, StoredRegisteredUser>();

let loaded = false;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function resolveStorePath(): string {
  return path.resolve(process.cwd(), env.REGISTERED_USERS_PATH);
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/** Load the JSON file at boot. Missing file is fine; corrupt file logs and starts empty. */
export async function loadRegisteredUsers(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const filePath = resolveStorePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      logger.info({ filePath }, "Registered-users store does not exist yet; starting empty.");
      return;
    }
    logger.error({ err, filePath }, "Failed to read registered-users store; starting empty.");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error({ err, filePath }, "Registered-users store is not valid JSON; refusing to overwrite, starting empty.");
    return;
  }
  if (!Array.isArray(parsed)) {
    logger.error({ filePath }, "Registered-users store must be a JSON array; starting empty.");
    return;
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const userId = typeof e.userId === "string" ? e.userId.trim() : "";
    const email = typeof e.email === "string" ? normalizeEmail(e.email) : "";
    const displayName = typeof e.displayName === "string" ? e.displayName : "";
    const passwordHash = typeof e.passwordHash === "string" ? e.passwordHash : "";
    const createdAt = typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString();
    const role = isStoredRole(e.role) ? e.role : null;
    if (!userId || !email || !passwordHash || !role) {
      logger.warn({ entry: e }, "Skipping malformed registered-users row.");
      continue;
    }
    const row: StoredRegisteredUser = { userId, email, displayName, role, passwordHash, createdAt };
    usersByEmail.set(email, row);
    usersById.set(userId, row);
  }
  logger.info({ filePath, count: usersByEmail.size }, "Registered-users store loaded.");
}

async function flushToDisk(): Promise<void> {
  const filePath = resolveStorePath();
  const rows: StoredRegisteredUser[] = Array.from(usersByEmail.values());
  const json = JSON.stringify(rows, null, 2);
  const tmpPath = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    await ensureDir(filePath);
    await fs.writeFile(tmpPath, json, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    logger.error({ err, filePath }, "Failed to persist registered-users store.");
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* tmp file may not exist */
    }
  }
}

/** Serialize writes so a fast-fire two-register doesn't interleave fs.rename. */
function queueFlush(): Promise<void> {
  writeQueue = writeQueue.then(flushToDisk, flushToDisk);
  return writeQueue;
}

export type RegisterRequest = {
  email: string;
  password: string;
  displayName: string;
  role: StoredRole;
};

export type RegisterResult =
  | { ok: true; user: RegisteredUser }
  | { ok: false; reason: "email_taken" };

function newUserId(): string {
  // Prefix matches the rest of the codebase's "<source>_<id>" convention so
  // log lines stay greppable. 16 bytes hex = 32 chars of entropy, plenty for
  // collision-free local generation.
  return `web_${randomBytes(16).toString("hex")}`;
}

/**
 * Persist a new account. Caller is responsible for invite-code consumption,
 * rate-limiting, and role-seeding (`ensureLocalRoleSeeded`) after success.
 */
export async function registerUser(req: RegisterRequest): Promise<RegisterResult> {
  if (!loaded) {
    // Defensive: register before load means we'd silently overwrite the disk
    // file with an empty-plus-one set. Force a load first.
    await loadRegisteredUsers();
  }
  const email = normalizeEmail(req.email);
  if (usersByEmail.has(email)) {
    return { ok: false, reason: "email_taken" };
  }
  const passwordHash = await argon2.hash(req.password, { type: argon2.argon2id });
  const row: StoredRegisteredUser = {
    userId: newUserId(),
    email,
    displayName: req.displayName,
    role: req.role,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  usersByEmail.set(email, row);
  usersById.set(row.userId, row);
  await queueFlush();
  return {
    ok: true,
    user: { userId: row.userId, email: row.email, displayName: row.displayName, role: row.role, createdAt: row.createdAt }
  };
}

/**
 * Update the stored display name for a self-registered user. Returns true if a
 * row was updated, false if no account with that id exists in this store
 * (typical for env-managed `WEB_LOGIN_USERS_JSON` users — the caller should
 * fall back to the in-memory override in `repository.ts` for those).
 *
 * Validation (length, character set) is the caller's responsibility; this
 * function only persists.
 */
export async function setRegisteredUserDisplayName(
  userId: string,
  displayName: string
): Promise<boolean> {
  if (!loaded) await loadRegisteredUsers();
  const row = usersById.get(userId);
  if (!row) return false;
  if (row.displayName === displayName) return true;
  row.displayName = displayName;
  await queueFlush();
  return true;
}

/** Returns the stored credential for an email, or null if no account exists. */
export function findCredentialByEmail(email: string): { userId: string; email: string; role: StoredRole; passwordHash: string } | null {
  const row = usersByEmail.get(normalizeEmail(email));
  if (!row) return null;
  return { userId: row.userId, email: row.email, role: row.role, passwordHash: row.passwordHash };
}

/** Returns true if the given userId belongs to a self-registered account. */
export function isRegisteredUserId(userId: string): boolean {
  return usersById.has(userId);
}

/**
 * Verify `currentPassword` and replace the stored hash with `newPassword`'s.
 * Returns:
 *   - { ok: true } on success
 *   - { ok: false, reason: "not_found" } if the user isn't in this store
 *   - { ok: false, reason: "wrong_password" } if argon2 verify fails
 * Plaintext is hashed with argon2id; the old hash is overwritten in place.
 */
export async function changeRegisteredUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "wrong_password" }> {
  if (!loaded) await loadRegisteredUsers();
  const row = usersById.get(userId);
  if (!row) return { ok: false, reason: "not_found" };
  let valid = false;
  try {
    valid = await argon2.verify(row.passwordHash, currentPassword);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "wrong_password" };
  row.passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await queueFlush();
  return { ok: true };
}

/**
 * Owner / supermod path: overwrite the password hash without checking the
 * current one. Caller must enforce its own authorization. Returns false if no
 * such registered user exists (e.g. trying to reset an env-managed account
 * which cannot be touched from this store).
 */
export async function adminResetRegisteredUserPassword(
  userId: string,
  newPassword: string
): Promise<boolean> {
  if (!loaded) await loadRegisteredUsers();
  const row = usersById.get(userId);
  if (!row) return false;
  row.passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await queueFlush();
  return true;
}

/**
 * All registered users (without password hashes). Used by webAuth's role-seed
 * pass at boot so getUserAccess can resolve roles immediately.
 */
export function listRegisteredUsers(): RegisteredUser[] {
  return Array.from(usersByEmail.values()).map((row) => ({
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    createdAt: row.createdAt
  }));
}
