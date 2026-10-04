import { describe, it, expect } from "vitest";
import { encodeKspPttPayload, parseKspPttPayload } from "./kspPttWire";

describe("ksp_ptt wire format (tower web ↔ Node voice-bridge)", () => {
  it("round-trips on/off with bridge identity", () => {
    const encOn = encodeKspPttPayload(true, "ksp_bridge");
    expect(parseKspPttPayload(encOn)).toEqual({ on: true, from: "ksp_bridge" });
    const encOff = encodeKspPttPayload(false, "ksp_bridge");
    expect(parseKspPttPayload(encOff)).toEqual({ on: false, from: "ksp_bridge" });
  });

  it("matches the bridge JSON shape (type + on + from)", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ type: "ksp_ptt", on: true, from: "ksp_bridge" })
    );
    expect(parseKspPttPayload(raw)).toEqual({ on: true, from: "ksp_bridge" });
  });

  it("returns null for wrong type or missing on", () => {
    expect(parseKspPttPayload(new TextEncoder().encode(`{"type":"ksp_ptt","from":"x"}`))).toBeNull();
    expect(parseKspPttPayload(new TextEncoder().encode(`{"type":"other","on":true}`))).toBeNull();
    expect(parseKspPttPayload(new TextEncoder().encode("not json"))).toBeNull();
  });

  it("treats missing from as empty string", () => {
    const raw = new TextEncoder().encode(JSON.stringify({ type: "ksp_ptt", on: true }));
    expect(parseKspPttPayload(raw)).toEqual({ on: true, from: "" });
  });

  it("parses payload with surrounding whitespace in JSON text", () => {
    const raw = new TextEncoder().encode(`  ${JSON.stringify({ type: "ksp_ptt", on: false, from: "ksp_bridge" })}  `);
    expect(parseKspPttPayload(raw)).toEqual({ on: false, from: "ksp_bridge" });
  });
});
