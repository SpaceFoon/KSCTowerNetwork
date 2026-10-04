import { DEV_VOICE_IDENTITY_HEADER, getDevVoiceIdentity } from "./devVoice";

const TOKEN_KEY = "ksc_tower_bearer";
const CSRF_COOKIE_NAME = "ksc_tower_csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Absolute base for backend API calls. Set at build time via `VITE_API_BASE`
 * (e.g. `https://api.tower.example.com`). When unset (dev / single-origin
 * production where the backend serves the SPA), we fall through to relative
 * paths and the Vite dev proxy or same-origin serving handles routing.
 */
const RAW_API_BASE = (import.meta.env.VITE_API_BASE ?? "").trim();
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

/** Joins `API_BASE` with a request path. Leaves absolute URLs untouched. */
export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!API_BASE) {
    return path;
  }
  return path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
}

export function getApiBase(): string {
  return API_BASE;
}

/**
 * Bearer token storage is kept around for back-compat (KSP plugin sessions,
 * dev tooling, paths still using bearer auth). The web UI's main credential
 * is now an HttpOnly session cookie set by /v1/auth/login, so JS literally
 * cannot read or steal the token even if an XSS slips past the SVG sanitizer.
 */
export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setStoredToken(token: string): void {
  if (token.trim()) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

/** Read the double-submit CSRF cookie set by /v1/auth/login or /v1/auth/csrf. */
function readCsrfCookie(): string {
  const all = document.cookie || "";
  for (const part of all.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    if (name !== CSRF_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1));
  }
  return "";
}

let csrfBootstrap: Promise<void> | null = null;

/**
 * Ensures the CSRF cookie/token pair exists. Called automatically before any
 * mutating fetch when the cookie is missing. Idempotent and de-duplicated so
 * a burst of POSTs only triggers one /v1/auth/csrf round-trip.
 */
async function ensureCsrfToken(): Promise<void> {
  if (readCsrfCookie()) return;
  if (csrfBootstrap) {
    await csrfBootstrap;
    return;
  }
  csrfBootstrap = (async () => {
    try {
      await fetch(resolveApiUrl("/v1/auth/csrf"), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" }
      });
    } catch {
      /* offline / network — the subsequent POST will surface the error */
    } finally {
      csrfBootstrap = null;
    }
  })();
  await csrfBootstrap;
}

export type ApiErrorBody = { error?: string; details?: unknown };

/** `status === 0` means fetch never reached an HTTP response (offline, wrong URL, CORS, etc.). */
export function isApiUnreachable(r: { ok: boolean; status: number }): boolean {
  return !r.ok && r.status === 0;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<{ ok: true; data: T; status: number } | { ok: false; status: number; body: unknown; message: string }> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body != null) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    // Still send Authorization when a token is present so plugin/guest flows
    // and existing localStorage-based sessions keep working. The cookie path
    // is additive: requests carry both, the server prefers Authorization.
    headers.set("Authorization", `Bearer ${token}`);
  }
  const devVoice = getDevVoiceIdentity();
  if (devVoice) {
    headers.set(DEV_VOICE_IDENTITY_HEADER, devVoice);
  }

  // Double-submit CSRF: only required for cookie-authed mutations, but cheap
  // to attach on every request so the server never has to special-case.
  const method = (init.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    await ensureCsrfToken();
    const csrf = readCsrfCookie();
    if (csrf && !headers.has(CSRF_HEADER_NAME)) {
      headers.set(CSRF_HEADER_NAME, csrf);
    }
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(resolveApiUrl(path), {
      ...init,
      headers,
      // `include` is required for the session cookie to ride cross-origin in
      // prod. The backend's CORS allowlist makes this safe.
      credentials: init.credentials ?? "include"
    });
    text = await res.text();
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      const message = "Request was cancelled.";
      return { ok: false, status: 0, body: { error: message }, message };
    }
    const cause = e instanceof Error ? e.message : String(e);
    const base =
      "Cannot reach the tower API. Start the backend or check the dev proxy / base URL (no HTTP response).";
    const message = import.meta.env.DEV ? `${base} (${cause})` : base;
    return {
      ok: false,
      status: 0,
      body: { error: message, cause },
      message
    };
  }

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const err = parsed as ApiErrorBody;
    const message =
      typeof err?.error === "string" ? err.error : `${res.status} ${res.statusText}`;
    return { ok: false, status: res.status, body: parsed, message };
  }

  return { ok: true, data: parsed as T, status: res.status };
}

/**
 * Same auth / CSRF / credentials behaviour as {@link apiFetch}, but returns the
 * raw `Response` so callers can read binary bodies (e.g. WAV) without JSON decode.
 */
export async function apiFetchResponse(
  path: string,
  init: RequestInit = {}
): Promise<
  | { ok: true; response: Response; status: number }
  | { ok: false; status: number; body: unknown; message: string }
> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body != null) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const devVoice = getDevVoiceIdentity();
  if (devVoice) {
    headers.set(DEV_VOICE_IDENTITY_HEADER, devVoice);
  }

  const method = (init.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    await ensureCsrfToken();
    const csrf = readCsrfCookie();
    if (csrf && !headers.has(CSRF_HEADER_NAME)) {
      headers.set(CSRF_HEADER_NAME, csrf);
    }
  }

  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path), {
      ...init,
      headers,
      credentials: init.credentials ?? "include"
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, status: 0, body: { error: "Request was cancelled." }, message: "Request was cancelled." };
    }
    const cause = e instanceof Error ? e.message : String(e);
    const base =
      "Cannot reach the tower API. Start the backend or check the dev proxy / base URL (no HTTP response).";
    const message = import.meta.env.DEV ? `${base} (${cause})` : base;
    return {
      ok: false,
      status: 0,
      body: { error: message, cause },
      message
    };
  }

  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { raw: text };
      }
    }
    const err = parsed as ApiErrorBody;
    const message =
      typeof err?.error === "string" ? err.error : `${res.status} ${res.statusText}`;
    return { ok: false, status: res.status, body: parsed, message };
  }

  return { ok: true, response: res, status: res.status };
}
