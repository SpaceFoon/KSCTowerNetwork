import { describe, it, expect } from "vitest";
import { authUserFromResponse, userHasCapability, type AuthUser } from "./session";

describe("userHasCapability", () => {
  const user: AuthUser = {
    id: "u1",
    email: null,
    displayName: "T",
    role: "controller",
    capabilities: ["chat:session", "voice:speak"],
    isOwner: false,
    isMod: false,
    isAdmin: false,
    isTower: true,
    isGuest: false
  };

  it("returns false for null user", () => {
    expect(userHasCapability(null, "chat:session")).toBe(false);
  });

  it("reflects capabilities array", () => {
    expect(userHasCapability(user, "chat:session")).toBe(true);
    expect(userHasCapability(user, "owner:grant_role")).toBe(false);
  });
});

describe("authUserFromResponse", () => {
  it("returns null for bad payloads", () => {
    expect(authUserFromResponse(null)).toBeNull();
    expect(authUserFromResponse({})).toBeNull();
    expect(authUserFromResponse({ id: "" })).toBeNull();
  });

  it("normalizes a minimal user object", () => {
    const u = authUserFromResponse({
      id: "abc",
      role: "pilot",
      capabilities: ["plugin:use"]
    });
    expect(u?.id).toBe("abc");
    expect(u?.role).toBe("pilot");
    expect(u?.capabilities).toEqual(["plugin:use"]);
    expect(u?.isGuest).toBe(false);
  });

  it("coerces unknown role to pilot", () => {
    const u = authUserFromResponse({ id: "x", role: "nope" });
    expect(u?.role).toBe("pilot");
  });
});
