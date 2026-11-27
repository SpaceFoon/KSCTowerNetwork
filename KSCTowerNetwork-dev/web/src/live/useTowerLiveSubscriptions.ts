import { useEffect, useState } from "react";
import { getApiBase, getStoredToken } from "../api/client";
import { fetchSiteInfo } from "../api/site";
import { queryClient, queryKeys } from "../query/client";

type ConnectionListener = (connected: boolean) => void;

const DEFAULT_LIVE_WS_PATH = "/v1/live/ws";
/** Endpoint path the server reports in /site/info; cached once a fetch succeeds. */
let liveWsPath: string | null = null;

function loadLiveWsPath(): Promise<string> {
  if (liveWsPath) return Promise.resolve(liveWsPath);
  // A failed lookup is not cached, so the next open asks again.
  return fetchSiteInfo()
    .then((info) => {
      liveWsPath = info.live?.wsPath || DEFAULT_LIVE_WS_PATH;
      return liveWsPath;
    })
    .catch(() => DEFAULT_LIVE_WS_PATH);
}

/**
 * One socket, one session: the backend only pushes `session.*` / `hullcam.meta`
 * for the sessionId in the URL. The first retained session owns the socket; other
 * callers (e.g. per-room status cards) are counted but do not steal it, and they
 * see `connected === false` so their queries keep polling. Previously the last
 * caller re-pointed the socket at its own room while every caller still read
 * `connected === true`, so the tracked room silently stopped updating.
 */
type SharedLiveSocket = {
  socket: WebSocket | null;
  /** Token for a socket whose endpoint path is still being looked up; null when none is pending. */
  pendingOpen: object | null;
  refs: number;
  /** Retain counts per session id ("" = global topics only). */
  sessionRefs: Map<string, number>;
  sessionId: string;
  connected: boolean;
  listeners: Set<ConnectionListener>;
};

const shared: SharedLiveSocket = {
  socket: null,
  pendingOpen: null,
  refs: 0,
  sessionRefs: new Map(),
  sessionId: "",
  connected: false,
  listeners: new Set()
};

function notifyConnected(next: boolean): void {
  shared.connected = next;
  for (const listener of shared.listeners) {
    try {
      listener(next);
    } catch {
      // ignore
    }
  }
}

function resolveWsUrl(sessionId: string, path: string): string {
  const base = getApiBase();
  const token = getStoredToken().trim();
  let origin: string;
  if (base) {
    const u = new URL(base, window.location.origin);
    origin = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
  } else {
    origin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  }
  const url = new URL(path, origin);
  if (token) url.searchParams.set("token", token);
  if (sessionId.trim()) url.searchParams.set("sessionId", sessionId.trim());
  return url.toString();
}

function handleSnapshotMessage(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const payload = message as {
    type?: string;
    topic?: string;
    sessionId?: string;
    data?: unknown;
  };
  if (payload.type !== "snapshot" || typeof payload.topic !== "string") return;

  if (payload.topic === "tower.active-aircraft") {
    queryClient.setQueryData(queryKeys.tower.activeAircraft(), payload.data);
    return;
  }
  if (payload.topic === "session.detail" && typeof payload.sessionId === "string") {
    queryClient.setQueryData(queryKeys.session.detail(payload.sessionId), payload.data);
    return;
  }
  if (payload.topic === "session.messages" && typeof payload.sessionId === "string") {
    queryClient.setQueryData(queryKeys.session.messages(payload.sessionId), payload.data);
    return;
  }
  if (payload.topic === "hullcam.meta" && typeof payload.sessionId === "string") {
    queryClient.setQueryData(queryKeys.session.hullCamCameras(payload.sessionId), payload.data);
    return;
  }
  if (payload.topic === "tower.view-streams") {
    queryClient.setQueryData(queryKeys.tower.viewStreams(), payload.data);
  }
}

function closeSocket(): void {
  shared.pendingOpen = null;
  const sock = shared.socket;
  if (!sock) return;
  shared.socket = null;
  try {
    sock.close(1000, "client unsubscribe");
  } catch {
    // ignore
  }
  notifyConnected(false);
}

function openSocket(sessionId: string): void {
  closeSocket();
  const sid = sessionId.trim();
  shared.sessionId = sid;
  // The endpoint path comes from the server; connect once it is known. The token lets a
  // close or a newer open cancel this attempt before it creates a socket.
  const attempt = {};
  shared.pendingOpen = attempt;
  void loadLiveWsPath().then((path) => {
    if (shared.pendingOpen !== attempt) return;
    shared.pendingOpen = null;
    connectSocket(sid, path);
  });
}

function connectSocket(sessionId: string, path: string): void {
  const socket = new WebSocket(resolveWsUrl(sessionId, path));
  shared.socket = socket;
  socket.addEventListener("open", () => {
    notifyConnected(true);
  });
  socket.addEventListener("close", () => {
    if (shared.socket === socket) {
      shared.socket = null;
      notifyConnected(false);
    }
  });
  socket.addEventListener("error", () => {
    if (shared.socket === socket) {
      notifyConnected(false);
    }
  });
  socket.addEventListener("message", (ev) => {
    try {
      handleSnapshotMessage(JSON.parse(String(ev.data)));
    } catch {
      // Ignore malformed payloads.
    }
  });
}

function retainSocket(sessionId: string): void {
  shared.refs += 1;
  const sid = sessionId.trim();
  shared.sessionRefs.set(sid, (shared.sessionRefs.get(sid) ?? 0) + 1);
  if (!shared.socket && !shared.pendingOpen) {
    openSocket(sid);
    return;
  }
  // Upgrade a global-only socket to the first real session; never steal one.
  if (sid && !shared.sessionId) {
    openSocket(sid);
  }
}

function releaseSocket(sessionId: string): void {
  shared.refs = Math.max(0, shared.refs - 1);
  const sid = sessionId.trim();
  const left = (shared.sessionRefs.get(sid) ?? 1) - 1;
  if (left > 0) shared.sessionRefs.set(sid, left);
  else shared.sessionRefs.delete(sid);
  if (shared.refs === 0) {
    closeSocket();
    shared.sessionId = "";
    shared.sessionRefs.clear();
    return;
  }
  if (sid === shared.sessionId && left <= 0) {
    // Owner went away. Defer the hand-off: when the owner merely switched rooms,
    // React runs this cleanup and the new retain in the same commit, and the new
    // room should win over some unrelated card that happens to be mounted.
    shared.sessionId = "";
    queueMicrotask(() => {
      if (shared.refs === 0) return;
      if (shared.sessionId && shared.sessionRefs.has(shared.sessionId)) return;
      const next = [...shared.sessionRefs.keys()].find((k) => k !== "") ?? "";
      openSocket(next);
    });
  }
}

/** Whether pushes for `sessionId` actually arrive on the shared socket. */
function coversSession(sessionId: string): boolean {
  const sid = sessionId.trim();
  return !sid || sid === shared.sessionId;
}

export function useTowerLiveSubscriptions(sessionId: string): boolean {
  const [connected, setConnected] = useState(shared.connected && coversSession(sessionId));
  useEffect(() => {
    const listener: ConnectionListener = (next) => setConnected(next && coversSession(sessionId));
    shared.listeners.add(listener);
    listener(shared.connected);
    return () => {
      shared.listeners.delete(listener);
    };
  }, [sessionId]);

  useEffect(() => {
    retainSocket(sessionId);
    notifyConnected(shared.connected);
    return () => releaseSocket(sessionId);
  }, [sessionId]);

  return connected;
}

/** Exposed for unit tests only. */
export const __liveSocketTestHooks = { retainSocket, releaseSocket, coversSession, shared };
