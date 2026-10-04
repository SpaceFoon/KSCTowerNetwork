import { describe, expect, it } from "vitest";
import { isApiUnreachable } from "./client";

describe("isApiUnreachable", () => {
  it("is true when status is 0 (network/CORS/offline)", () => {
    expect(isApiUnreachable({ ok: false, status: 0 })).toBe(true);
  });

  it("is false for HTTP error responses", () => {
    expect(isApiUnreachable({ ok: false, status: 502 })).toBe(false);
    expect(isApiUnreachable({ ok: false, status: 404 })).toBe(false);
  });

  it("is false for successful responses", () => {
    expect(isApiUnreachable({ ok: true, status: 200 })).toBe(false);
  });
});
