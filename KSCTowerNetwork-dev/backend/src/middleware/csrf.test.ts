import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfGuard,
  generateCsrfToken
} from "./csrf";

describe("csrf helpers", () => {
  it("generateCsrfToken returns a non-trivial base64url string", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    assert.ok(a.length >= 40);
    assert.notEqual(a, b);
  });
});

describe("csrfGuard", () => {
  it("allows safe methods without auth", () => {
    let nextCalled = false;
    const req = { method: "GET", header: () => undefined } as unknown as Request;
    const res = {} as Response;
    csrfGuard(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
  });

  it("skips check when auth is not cookie-based", () => {
    let nextCalled = false;
    const req = {
      method: "POST",
      auth: { authSource: "bearer" },
      header: () => undefined
    } as unknown as Request;
    const res = {} as Response;
    csrfGuard(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
  });

  it("checks a session cookie before route authentication has populated req.auth", () => {
    let status = 0;
    let body: unknown;
    const req = {
      method: "POST",
      header: () => undefined,
      cookies: { ksc_tower_session: "signed-session" }
    } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
      }
    } as unknown as Response;
    let nextCalled = false;
    csrfGuard(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(status, 403);
    assert.equal((body as { reason?: string }).reason, "csrf_missing");
  });

  it("returns 403 when cookie auth but tokens missing", () => {
    let status = 0;
    let body: unknown;
    const req = {
      method: "POST",
      auth: { authSource: "cookie" },
      header: () => undefined,
      cookies: {}
    } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
      }
    } as unknown as Response;
    let nextCalled = false;
    csrfGuard(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(status, 403);
    assert.equal((body as { reason?: string }).reason, "csrf_missing");
  });

  it("returns 403 on token mismatch", () => {
    let status = 0;
    const req = {
      method: "POST",
      auth: { authSource: "cookie" },
      header: (name: string) => (name === CSRF_HEADER_NAME ? "aaa" : undefined),
      cookies: { [CSRF_COOKIE_NAME]: "bbb" }
    } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        /* noop */
      }
    } as unknown as Response;
    csrfGuard(req, res, () => assert.fail("next should not run"));
    assert.equal(status, 403);
  });

  it("calls next when header matches cookie", () => {
    let nextCalled = false;
    const tok = "same-token-value";
    const req = {
      method: "POST",
      auth: { authSource: "cookie" },
      header: (name: string) => (name === CSRF_HEADER_NAME ? tok : undefined),
      cookies: { [CSRF_COOKIE_NAME]: tok }
    } as unknown as Request;
    const res = {} as Response;
    csrfGuard(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
