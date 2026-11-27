import { beforeAll, describe, expect, it } from "vitest";

/**
 * The browser must open the WebSocket at the path the server advertises in /site/info, so a
 * deployment that moves LIVE_WS_PATH keeps live updates instead of silently polling.
 */
const opened: string[] = [];

class FakeSocket {
  url: string;
  constructor(url: string) {
    this.url = url;
    opened.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

let hooks: typeof import("./useTowerLiveSubscriptions").__liveSocketTestHooks;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeSocket;
  g.window = { location: { origin: "http://localhost", protocol: "http:", host: "localhost" } };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  };
  g.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        project: { displayName: "t", tagline: "t", repoUrl: null, discordUrl: null },
        plugin: { ckanIdentifier: null, ckanCatalogUrl: null, downloadUrl: null, radioPresets: [] },
        registration: {
          mode: "closed",
          defaultRole: "pilot",
          signupEnabled: false,
          inviteRequired: false,
          inviteAccepted: false,
          passwordMinLength: 8
        },
        live: { wsPath: "/custom/live-feed" }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  hooks = (await import("./useTowerLiveSubscriptions")).__liveSocketTestHooks;
});

describe("live socket endpoint", () => {
  it("connects to the WebSocket path the server advertises", async () => {
    hooks.retainSocket("PATH-TEST");
    // The path lookup and the socket creation are both promise steps.
    for (let i = 0; i < 20 && opened.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(opened.length).toBeGreaterThan(0);
    const url = new URL(opened[0]!);
    expect(url.pathname).toBe("/custom/live-feed");
    expect(url.searchParams.get("sessionId")).toBe("PATH-TEST");
    hooks.releaseSocket("PATH-TEST");
  });
});
