import { describe, it, expect } from "vitest";
import { mapHttpStatusToVoiceErrorKind } from "./livekit";

describe("mapHttpStatusToVoiceErrorKind", () => {
  it("maps known statuses to stable kinds", () => {
    expect(mapHttpStatusToVoiceErrorKind(403)).toBe("forbidden");
    expect(mapHttpStatusToVoiceErrorKind(404)).toBe("not_found");
    expect(mapHttpStatusToVoiceErrorKind(503)).toBe("livekit_unavailable");
  });

  it("maps everything else to unknown", () => {
    expect(mapHttpStatusToVoiceErrorKind(500)).toBe("unknown");
    expect(mapHttpStatusToVoiceErrorKind(0)).toBe("unknown");
    expect(mapHttpStatusToVoiceErrorKind(401)).toBe("unknown");
    expect(mapHttpStatusToVoiceErrorKind(429)).toBe("unknown");
  });
});
