import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import { env } from "../config/env";

/**
 * Double-submit CSRF: a non-HttpOnly cookie carries the token so JS can read it,
 * and the same value must be sent back as `X-CSRF-Token`. An attacker on a
 * different origin can't read the cookie, so they can't forge the header.
 *
 * The check ONLY runs when the auth source is the session cookie. Bearer-auth
 * requests (KSP plugin, voice bridge, third-party tooling) are not vulnerable
 * to CSRF because the browser doesn't auto-attach the Authorization header.
 */

export const SESSION_COOKIE_NAME = "ksc_tower_session";
export const CSRF_COOKIE_NAME = "ksc_tower_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Cookie attributes shared by session + CSRF cookies. */
export function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    // `Secure` is required by browsers for `SameSite=None`; for `Lax` it is
    // strongly recommended in prod. In dev over plain http we leave it off so
    // localhost works without a cert.
    secure: env.NODE_ENV === "production",
    path: "/"
  };
}

export function csrfCookieOptions(): CookieOptions {
  // Same attributes as the session cookie EXCEPT `httpOnly: false` so the SPA
  // can read it and echo into the X-CSRF-Token header.
  return {
    ...baseCookieOptions(),
    httpOnly: false
  };
}

/**
 * Enforces double-submit CSRF for cookie-authed mutations. Bearer-authed
 * requests pass through unchanged.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.auth?.authSource !== "cookie") {
    next();
    return;
  }
  const headerToken = req.header(CSRF_HEADER_NAME);
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[CSRF_COOKIE_NAME];
  if (!headerToken || !cookieToken) {
    res.status(403).json({ error: "Missing CSRF token", reason: "csrf_missing" });
    return;
  }
  const a = Buffer.from(headerToken, "utf8");
  const b = Buffer.from(cookieToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid CSRF token", reason: "csrf_mismatch" });
    return;
  }
  next();
}
