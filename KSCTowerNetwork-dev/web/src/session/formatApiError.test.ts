import { describe, it, expect } from "vitest";
import { formatApiError } from "./formatApiError";

describe("formatApiError", () => {
  it("expands 404 for session-like contexts", () => {
    const a = formatApiError(404, "missing", "session");
    expect(a).toMatch(/No session with this id/);
    expect(a).toMatch(/Lobby/);
    const b = formatApiError(404, "nope", "messages");
    expect(b).toMatch(/No session with this id/);
    const c = formatApiError(404, "gone", "send");
    expect(c).toMatch(/No session with this id/);
  });

  it("handles 404 for rotate context", () => {
    const s = formatApiError(404, "x", "rotate");
    expect(s).toMatch(/no longer exists/);
    expect(s).toMatch(/tower could not be rotated/);
  });

  it("passes through 404 for other contexts", () => {
    expect(formatApiError(404, "raw msg", "livekit")).toBe("raw msg");
  });

  it("expands common 403 session/voice messages", () => {
    const s = formatApiError(403, "Not authorized for this session", "session");
    expect(s).toMatch(/cannot access this session/);
    const v = formatApiError(403, "Not authorized for this room", "livekit");
    expect(v).toMatch(/Voice:/);
    const r = formatApiError(403, "Only pilot can rotate tower", "session");
    expect(r).toMatch(/hand off to the next tower/);
  });

  it("maps 503 LiveKit misconfiguration", () => {
    const s = formatApiError(503, "LiveKit down", "livekit");
    expect(s).toMatch(/Voice is unavailable/);
    expect(s).toMatch(/LIVEKIT_API_KEY/);
  });

  it("adds dev hint for short 401/403 on send", () => {
    const s = formatApiError(401, "bad", "send");
    expect(s).toMatch(/dev mode/);
  });
});
