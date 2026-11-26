import { beforeAll, describe, expect, it } from "vitest";

class FakeSocket {
  static opened: string[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(new URL(url).searchParams.get("sessionId") ?? "");
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
  hooks = (await import("./useTowerLiveSubscriptions")).__liveSocketTestHooks;
});

describe("shared live socket ownership", () => {
  it("does not let a second room steal the socket from the tracked room", async () => {
    const { retainSocket, releaseSocket, coversSession, shared } = hooks;
    retainSocket("A");
    retainSocket("B");
    expect(shared.sessionId).toBe("A");
    expect(coversSession("A")).toBe(true);
    expect(coversSession("B")).toBe(false);
    expect(coversSession("")).toBe(true);

    // Tracked desk switches A -> C in one commit: C should win over card B.
    releaseSocket("A");
    retainSocket("C");
    await Promise.resolve();
    expect(shared.sessionId).toBe("C");

    // Last holder of the owner goes away: hand off to a session still held.
    releaseSocket("C");
    await Promise.resolve();
    expect(shared.sessionId).toBe("B");

    releaseSocket("B");
    await Promise.resolve();
    expect(shared.socket).toBe(null);
    expect(shared.refs).toBe(0);
  });
});
