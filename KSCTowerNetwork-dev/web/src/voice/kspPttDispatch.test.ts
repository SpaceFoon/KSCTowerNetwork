import { describe, it, expect, vi } from "vitest";
import { encodeKspPttPayload } from "./kspPttWire";
import { dispatchKspPttData } from "./kspPttDispatch";

describe("dispatchKspPttData (LiveKit DataReceived → tower callback)", () => {
  it("invokes callback with on and from when payload carries from", () => {
    const cb = vi.fn();
    dispatchKspPttData(encodeKspPttPayload(true, "ksp_bridge"), undefined, cb);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(true, "ksp_bridge");
  });

  it("falls back to participant.identity when from is empty", () => {
    const cb = vi.fn();
    const payload = new TextEncoder().encode(JSON.stringify({ type: "ksp_ptt", on: false }));
    dispatchKspPttData(payload, { identity: "ksp_bridge" }, cb);
    expect(cb).toHaveBeenCalledWith(false, "ksp_bridge");
  });

  it("prefers explicit from over participant.identity", () => {
    const cb = vi.fn();
    dispatchKspPttData(encodeKspPttPayload(true, "ksp_bridge"), { identity: "someone_else" }, cb);
    expect(cb).toHaveBeenCalledWith(true, "ksp_bridge");
  });

  it("does not call callback for non-ksp_ptt payloads", () => {
    const cb = vi.fn();
    dispatchKspPttData(new TextEncoder().encode("{}"), { identity: "x" }, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores ksp_ptt when on is not a boolean (strict wire contract)", () => {
    const cb = vi.fn();
    const raw = new TextEncoder().encode(JSON.stringify({ type: "ksp_ptt", on: 1, from: "ksp_bridge" }));
    dispatchKspPttData(raw, undefined, cb);
    expect(cb).not.toHaveBeenCalled();
  });
});
