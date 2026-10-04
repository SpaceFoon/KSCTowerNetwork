import { apiFetch, setStoredToken } from "../api/client";

const USER_KEY = "ksc_tower_user";

export type Role = "guest" | "pilot" | "controller" | "mod" | "supermod" | "owner";

export type Capability =
  | "chat:lobby"
  | "chat:session"
  | "chat:dm"
  /** Send messages in the spectator booth chat (pilot+ baseline; pilots are still room-blocked). */
  | "chat:booth"
  | "voice:speak"
  | "plugin:use"
  | "controller:assume"
  /** Toggle the spectator booth kill-switch. Granted at controller+. */
  | "booth:moderate"
  | "mod:mute"
  | "mod:ban_temp"
  | "mod:ban_perm"
  | "mod:ban_ip"
  | "owner:grant_role";

export type AuthUser = {
  id: string;
  email: string | null;
  /** Pilot callsign (API field `displayName` or `callsign` — same value). Shown in UI and LiveKit. */
  displayName: string | null;
  role: Role;
  /** Server-resolved capability set; UI gates off this rather than the role string. */
  capabilities: Capability[];
  /** Convenience flags duplicated from the role; gates legacy nav code. */
  isOwner: boolean;
  isMod: boolean;
  isAdmin: boolean;
  isTower: boolean;
  isGuest: boolean;
};

const VALID_ROLES: ReadonlySet<Role> = new Set([
  "guest",
  "pilot",
  "controller",
  "mod",
  "supermod",
  "owner"
]);

function coerceRole(value: unknown): Role {
  if (typeof value === "string" && VALID_ROLES.has(value as Role)) {
    return value as Role;
  }
  return "pilot";
}

function coerceCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Capability => typeof v === "string");
}

export function userHasCapability(user: AuthUser | null, cap: Capability): boolean {
  if (!user) return false;
  return user.capabilities.includes(cap);
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser> & {
      role?: unknown;
      capabilities?: unknown;
      callsign?: unknown;
    };
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    const role = coerceRole(parsed.role);
    const capabilities = coerceCapabilities(parsed.capabilities);
    const label =
      typeof parsed.displayName === "string"
        ? parsed.displayName
        : typeof parsed.callsign === "string"
          ? parsed.callsign
          : null;
    return {
      id: parsed.id,
      email: typeof parsed.email === "string" ? parsed.email : null,
      displayName: label,
      role,
      capabilities,
      isOwner: parsed.isOwner === true || role === "owner",
      isMod: parsed.isMod === true || role === "mod" || role === "supermod" || role === "owner",
      isAdmin: parsed.isAdmin === true,
      isTower: parsed.isTower === true,
      isGuest: parsed.isGuest === true || role === "guest"
    };
  } catch {
    return null;
  }
}

export function setStoredUser(user: AuthUser | null): void {
  if (!user) {
    localStorage.removeItem(USER_KEY);
    return;
  }
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Sign out: best-effort POST /v1/auth/logout to clear server-side cookies,
 * then wipe everything client-side. We deliberately do not block on the
 * server call — the local clear is what the user actually wants, and a stuck
 * network shouldn't trap them in a "still logged in" UI.
 */
export async function clearStoredSession(): Promise<void> {
  try {
    await apiFetch("/v1/auth/logout", { method: "POST" });
  } catch {
    /* offline or already-expired session — fall through */
  }
  setStoredToken("");
  setStoredUser(null);
}

/**
 * Normalize a `/v1/auth/*` user payload into our AuthUser shape. Tolerates partial responses
 * from older backends so a stale browser doesn't end up with a half-populated session.
 */
export function authUserFromResponse(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  const role = coerceRole(obj.role);
  const label =
    typeof obj.displayName === "string"
      ? obj.displayName
      : typeof obj.callsign === "string"
        ? obj.callsign
        : null;
  return {
    id: obj.id,
    email: typeof obj.email === "string" ? obj.email : null,
    displayName: label,
    role,
    capabilities: coerceCapabilities(obj.capabilities),
    isOwner: obj.isOwner === true || role === "owner",
    isMod: obj.isMod === true || role === "mod" || role === "supermod" || role === "owner",
    isAdmin: obj.isAdmin === true,
    isTower: obj.isTower === true,
    isGuest: obj.isGuest === true || role === "guest"
  };
}
