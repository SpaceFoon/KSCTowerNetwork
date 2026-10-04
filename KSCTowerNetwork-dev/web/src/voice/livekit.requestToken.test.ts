import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../api/client", () => ({
  apiFetch: apiFetchMock
}));

import { requestLiveKitToken } from "./livekit";

describe("requestLiveKitToken (tower web → POST /v1/session/…/livekit-token)", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("rejects blank session id before calling the API", async () => {
    const r = await requestLiveKitToken("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("no_token");
      expect(r.status).toBe(0);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("maps 401 to unknown (not a dedicated VoiceErrorKind)", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      body: {},
      message: "Unauthorized"
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unknown");
  });

  it("maps 403 to forbidden", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: {},
      message: "Not allowed"
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("forbidden");
  });

  it("maps 503 to livekit_unavailable", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: {},
      message: "LiveKit is not configured"
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("livekit_unavailable");
  });

  it("maps 404 to not_found (stale session id / bridge ahead of lobby)", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: { error: "Session not found" },
      message: "Session not found"
    });
    const r = await requestLiveKitToken("pilot-missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("not_found");
      expect(r.status).toBe(404);
    }
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/v1/session/pilot-missing/livekit-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ flavor: "ops" })
      })
    );
  });

  it("posts booth flavor when requested", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: {},
      message: "no"
    });
    await requestLiveKitToken("s1", "booth");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/v1/session/s1/livekit-token",
      expect.objectContaining({
        body: JSON.stringify({ flavor: "booth" })
      })
    );
  });

  it("posts lobby_ops flavor when requested", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: {},
      message: "no"
    });
    await requestLiveKitToken("s1", "lobby_ops");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/v1/session/s1/livekit-token",
      expect.objectContaining({
        body: JSON.stringify({ flavor: "lobby_ops" })
      })
    );
  });

  it("preserves lobby_ops flavor from server response", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        token: "t",
        wsUrl: "wss://x",
        canPublish: false,
        canSubscribe: true,
        roomName: "tower-s1",
        flavor: "lobby_ops"
      }
    });
    const r = await requestLiveKitToken("s1", "lobby_ops");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.flavor).toBe("lobby_ops");
  });

  it("defaults flavor to ops when the server omits flavor", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        token: "t",
        wsUrl: "wss://x",
        canPublish: true,
        canSubscribe: true,
        roomName: "tower-s1"
      }
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.flavor).toBe("ops");
  });

  it("returns ok with room caps when the payload is complete", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        token: "jwt-here",
        wsUrl: "wss://lk.example/ws",
        canPublish: true,
        canSubscribe: true,
        roomName: "tower-s1",
        flavor: "booth",
        boothMuted: true
      }
    });
    const r = await requestLiveKitToken("s1", "booth");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.token).toBe("jwt-here");
      expect(r.data.wsUrl).toBe("wss://lk.example/ws");
      expect(r.data.canPublish).toBe(true);
      expect(r.data.canSubscribe).toBe(true);
      expect(r.data.roomName).toBe("tower-s1");
      expect(r.data.flavor).toBe("booth");
      expect(r.data.boothMuted).toBe(true);
    }
  });

  it("fails when wsUrl string is missing on 200", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        token: "t",
        canPublish: false,
        canSubscribe: true
      }
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/WebSocket URL missing/);
      expect(r.kind).toBe("unknown");
    }
  });

  it("fails when token string is missing on 200", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        wsUrl: "wss://x",
        canPublish: false,
        canSubscribe: true
      }
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Token missing/);
      expect(r.kind).toBe("unknown");
    }
  });

  it("fails when canPublish / canSubscribe booleans are absent", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        token: "t",
        wsUrl: "wss://x"
      }
    });
    const r = await requestLiveKitToken("s1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/canPublish/);
    }
  });

  it("encodes session id in the URL path", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: {},
      message: "err"
    });
    await requestLiveKitToken("a/b");
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/v1/session/${encodeURIComponent("a/b")}/livekit-token`,
      expect.anything()
    );
  });
});
