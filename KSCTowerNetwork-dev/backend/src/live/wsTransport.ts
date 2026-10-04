import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { authenticateAppBearerToken } from "../middleware/auth";
import { getSession, getUserAccess, roleAtLeast, type Role, type SessionRecord } from "../services/repository";
import { incLiveMetric, setLiveWsSubscribers } from "./metrics";
import { subscribeLiveSnapshotBus } from "./liveSnapshotBus";
import {
  getActiveAircraftSnapshot,
  getHullcamMetaSnapshot,
  getSessionMessagesSnapshot,
  getSessionSnapshot,
  getTowerViewStreamsSnapshot,
  invalidateActiveAircraftSnapshot,
  invalidateHullcamMetaSnapshot,
  invalidateSessionMessagesSnapshot,
  invalidateSessionSnapshot
} from "./snapshotCache";

type LiveClient = {
  socket: WebSocket;
  userId: string;
  sessionId: string;
  ip: string;
};

function parseSocketParams(req: IncomingMessage): { token: string; sessionId: string } {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    token: (url.searchParams.get("token") ?? "").trim(),
    sessionId: (url.searchParams.get("sessionId") ?? "").trim()
  };
}

function sessionReadableByUser(session: SessionRecord, userId: string, role: Role): boolean {
  if (session.pilotUserId === userId) return true;
  if (session.assignedTowerUserId === userId) return true;
  if (session.spectatorUserIds.includes(userId)) return true;
  return roleAtLeast(role, "mod");
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
  incLiveMetric("ws_messages_out");
}

async function pushActiveAircraft(client: LiveClient): Promise<void> {
  const data = await getActiveAircraftSnapshot(client.userId);
  sendJson(client.socket, { type: "snapshot", topic: "tower.active-aircraft", data });
}

async function pushSession(client: LiveClient): Promise<void> {
  if (!client.sessionId) return;
  const snapshot = await getSessionSnapshot(client.sessionId);
  if (!snapshot) return;
  const access = await getUserAccess(client.userId);
  if (!sessionReadableByUser(snapshot.session, client.userId, access.role)) return;
  sendJson(client.socket, {
    type: "snapshot",
    topic: "session.detail",
    sessionId: client.sessionId,
    data: snapshot
  });
}

async function pushSessionMessages(client: LiveClient): Promise<void> {
  if (!client.sessionId) return;
  const session = await getSession(client.sessionId);
  if (!session) return;
  const access = await getUserAccess(client.userId);
  if (!sessionReadableByUser(session, client.userId, access.role)) return;
  const data = await getSessionMessagesSnapshot(client.sessionId);
  sendJson(client.socket, {
    type: "snapshot",
    topic: "session.messages",
    sessionId: client.sessionId,
    data
  });
}

async function pushHullcamMeta(client: LiveClient): Promise<void> {
  if (!client.sessionId) return;
  const session = await getSession(client.sessionId);
  if (!session) return;
  const access = await getUserAccess(client.userId);
  if (!sessionReadableByUser(session, client.userId, access.role)) return;
  const data = getHullcamMetaSnapshot(client.sessionId);
  sendJson(client.socket, {
    type: "snapshot",
    topic: "hullcam.meta",
    sessionId: client.sessionId,
    data
  });
}

function pushTowerViewStreams(client: LiveClient): void {
  const data = getTowerViewStreamsSnapshot();
  sendJson(client.socket, {
    type: "snapshot",
    topic: "tower.view-streams",
    data
  });
}

export function startWsLiveTransport(server: HttpServer): () => void {
  if (!env.LIVE_WS_ENABLED) {
    logger.info("Live WebSocket transport disabled (LIVE_WS_ENABLED=false)");
    return () => {};
  }
  const path = env.LIVE_WS_PATH.startsWith("/") ? env.LIVE_WS_PATH : `/${env.LIVE_WS_PATH}`;
  const wss = new WebSocketServer({ server, path });
  const clients = new Set<LiveClient>();

  const removeClient = (client: LiveClient): void => {
    clients.delete(client);
    setLiveWsSubscribers(clients.size);
  };

  const unsubBus = subscribeLiveSnapshotBus((event) => {
    if (event.topic === "active-aircraft") {
      invalidateActiveAircraftSnapshot();
    } else if (event.topic === "session") {
      invalidateSessionSnapshot(event.sessionId);
    } else if (event.topic === "session-messages") {
      invalidateSessionMessagesSnapshot(event.sessionId);
    } else if (event.topic === "hullcam-meta") {
      invalidateHullcamMetaSnapshot(event.sessionId);
    }

    for (const client of clients) {
      if (event.topic === "active-aircraft") {
        void pushActiveAircraft(client);
      } else if (event.topic === "session" && client.sessionId === event.sessionId) {
        void pushSession(client);
      } else if (event.topic === "session-messages" && client.sessionId === event.sessionId) {
        void pushSessionMessages(client);
      } else if (event.topic === "hullcam-meta" && client.sessionId === event.sessionId) {
        void pushHullcamMeta(client);
      } else if (event.topic === "hullcam-meta") {
        pushTowerViewStreams(client);
      }
    }
  });

  wss.on("connection", (socket, req) => {
    void (async () => {
      const { token, sessionId } = parseSocketParams(req);
      const ip = req.socket.remoteAddress ?? "";
      const auth =
        token.length > 0
          ? await authenticateAppBearerToken(token, ip)
          : env.DEV_OPEN_AUTH
          ? { userId: env.DEV_USER_ID, tokenType: "clerk" as const, authSource: "dev-open" as const, ip }
          : null;
      if (!auth?.userId) {
        socket.close(4001, "unauthorized");
        return;
      }

      const client: LiveClient = {
        socket,
        userId: auth.userId,
        sessionId,
        ip
      };
      clients.add(client);
      setLiveWsSubscribers(clients.size);

      void pushActiveAircraft(client);
      void pushSession(client);
      void pushSessionMessages(client);
      void pushHullcamMeta(client);
      pushTowerViewStreams(client);

      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string; sessionId?: string };
          if (msg.type === "subscribe" && typeof msg.sessionId === "string") {
            client.sessionId = msg.sessionId.trim();
            void pushSession(client);
            void pushSessionMessages(client);
            void pushHullcamMeta(client);
            pushTowerViewStreams(client);
          }
        } catch {
          // Ignore malformed control messages.
        }
      });

      socket.on("close", () => removeClient(client));
      socket.on("error", () => removeClient(client));
    })().catch((err) => {
      logger.warn({ err }, "WS live client init failed");
      try {
        socket.close(1011, "init failed");
      } catch {
        // ignore
      }
    });
  });

  const refreshTimer = setInterval(() => {
    for (const client of clients) {
      void pushActiveAircraft(client);
      void pushSession(client);
      void pushSessionMessages(client);
      void pushHullcamMeta(client);
      pushTowerViewStreams(client);
    }
  }, 5_000);

  logger.info({ path }, "Live WebSocket transport listening");

  return () => {
    clearInterval(refreshTimer);
    unsubBus();
    for (const client of clients) {
      try {
        client.socket.close(1001, "server shutdown");
      } catch {
        // ignore
      }
    }
    clients.clear();
    setLiveWsSubscribers(0);
    wss.close();
  };
}
