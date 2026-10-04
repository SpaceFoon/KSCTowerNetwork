import { useEffect, useState } from "react";
import { getApiBase, getStoredToken } from "../api/client";
import { queryClient, queryKeys } from "../query/client";

type ConnectionListener = (connected: boolean) => void;

type SharedLiveSocket = {
  socket: WebSocket | null;
  refs: number;
  sessionId: string;
  connected: boolean;
  listeners: Set<ConnectionListener>;
};

const shared: SharedLiveSocket = {
  socket: null,
  refs: 0,
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

function resolveWsUrl(sessionId: string): string {
  const base = getApiBase();
  const token = getStoredToken().trim();
  let origin: string;
  if (base) {
    const u = new URL(base, window.location.origin);
    origin = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
  } else {
    origin = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  }
  const url = new URL("/v1/live/ws", origin);
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
  const socket = new WebSocket(resolveWsUrl(sessionId));
  shared.socket = socket;
  shared.sessionId = sessionId.trim();
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
  if (!shared.socket) {
    openSocket(sid);
    return;
  }
  if (sid && shared.sessionId !== sid) {
    openSocket(sid);
  }
}

function releaseSocket(): void {
  shared.refs = Math.max(0, shared.refs - 1);
  if (shared.refs === 0) {
    closeSocket();
    shared.sessionId = "";
  }
}

export function useTowerLiveSubscriptions(sessionId: string): boolean {
  const [connected, setConnected] = useState(shared.connected);
  useEffect(() => {
    const listener: ConnectionListener = (next) => setConnected(next);
    shared.listeners.add(listener);
    return () => {
      shared.listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    retainSocket(sessionId);
    return () => releaseSocket();
  }, [sessionId]);

  return connected;
}
