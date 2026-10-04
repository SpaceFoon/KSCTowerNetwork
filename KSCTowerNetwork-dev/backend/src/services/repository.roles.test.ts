/**
 * Role hierarchy + capability grants — must match AUTH_AND_ROLES / frontend expectations.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilitiesFor, roleAtLeast, type Capability, type Role } from "./repository";

describe("roleAtLeast", () => {
  it("orders roles strictly by ROLE_RANK", () => {
    assert.equal(roleAtLeast("owner", "guest"), true);
    assert.equal(roleAtLeast("guest", "owner"), false);
    assert.equal(roleAtLeast("controller", "pilot"), true);
    assert.equal(roleAtLeast("pilot", "controller"), false);
    assert.equal(roleAtLeast("mod", "mod"), true);
  });
});

describe("capabilitiesFor", () => {
  it("guest gets lobby only (no DM / no voice)", () => {
    const c = capabilitiesFor("guest");
    assert.equal(c.has("chat:lobby"), true);
    assert.equal(c.has("chat:dm"), false);
    assert.equal(c.has("voice:speak"), false);
  });

  it("pilot gets session + DM + voice + plugin", () => {
    const c = capabilitiesFor("pilot");
    assert.equal(c.has("chat:session"), true);
    assert.equal(c.has("chat:dm"), true);
    assert.equal(c.has("voice:speak"), true);
    assert.equal(c.has("plugin:use"), true);
    assert.equal(c.has("controller:assume"), false);
  });

  it("controller adds assume + booth moderate", () => {
    const c = capabilitiesFor("controller");
    assert.equal(c.has("controller:assume"), true);
    assert.equal(c.has("booth:moderate"), true);
    assert.equal(c.has("mod:mute"), false);
  });

  it("mod adds moderation caps (not perm ban)", () => {
    const c = capabilitiesFor("mod");
    assert.equal(c.has("mod:mute"), true);
    assert.equal(c.has("mod:ban_temp"), true);
    assert.equal(c.has("mod:ban_perm"), false);
  });

  it("supermod adds perm ban", () => {
    const c = capabilitiesFor("supermod");
    assert.equal(c.has("mod:ban_perm"), true);
    assert.equal(c.has("owner:grant_role"), false);
  });

  it("owner gets grant_role", () => {
    const c = capabilitiesFor("owner");
    assert.equal(c.has("owner:grant_role"), true);
  });

  it("every capability appears for at least one role", () => {
    const allCaps = new Set<Capability>();
    const roles: Role[] = ["guest", "pilot", "controller", "mod", "supermod", "owner"];
    for (const r of roles) {
      for (const cap of capabilitiesFor(r)) {
        allCaps.add(cap);
      }
    }
    const expected: Capability[] = [
      "chat:lobby",
      "chat:session",
      "chat:dm",
      "chat:booth",
      "voice:speak",
      "plugin:use",
      "controller:assume",
      "booth:moderate",
      "mod:mute",
      "mod:ban_temp",
      "mod:ban_ip",
      "mod:ban_perm",
      "owner:grant_role"
    ];
    for (const cap of expected) {
      assert.equal(allCaps.has(cap), true, `missing capability ${cap}`);
    }
  });
});
