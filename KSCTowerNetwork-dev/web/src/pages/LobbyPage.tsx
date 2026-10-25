import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { userHasCapability, type AuthUser } from "../auth/session";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { useActiveRoomCached } from "../session/useActiveRoom";
import { LobbyOpsPlayback } from "../lobby/LobbyOpsPlayback";
import { displayMhzFromCanonical } from "../lib/displayMhz";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";

/**
 * Stash the session id in localStorage so the unified `/tower` workspace
 * (TowerDesk + ChatDesk + VoiceDesk + Wall) all pick up the same session
 * when the lobby navigates over. The App-level `useActiveRoom` query is
 * the canonical source of truth — this is just a paint-fast hint so the
 * desks don't show empty while waiting on the next active-room poll.
 */
function rememberSession(sessionId: string): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // localStorage might be disabled (private mode); fall through and let
    // useActiveRoom catch up on its next poll.
  }
}

function lobbyUserIdDmClickable(peerId: string, selfId: string, canDm: boolean): boolean {
  if (!canDm || !peerId || peerId === selfId) return false;
  if (peerId.startsWith("guest_") || peerId.startsWith("system:")) return false;
  return true;
}

function LobbyDmUserId({
  userId,
  selfId,
  canDm
}: {
  userId: string;
  selfId: string;
  canDm: boolean;
}): JSX.Element {
  if (!lobbyUserIdDmClickable(userId, selfId, canDm)) {
    return <span>{userId}</span>;
  }
  return (
    <Link
      to={`/dm?peer=${encodeURIComponent(userId)}`}
      title="Open direct messages with this person"
      style={{
        color: "var(--accent)",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        fontWeight: 500
      }}
    >
      {userId}
    </Link>
  );
}

type LobbyMessage = {
  id: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type LobbyMessagesResponse = {
  ok?: boolean;
  messages?: LobbyMessage[];
};

type RoomSummary = {
  roomId: string;
  /**
   * Human label rendered as the card heading — always populated by the backend
   * (auto-derived from the callsign when the operator hasn't chosen one). Never
   * a raw UUID. Examples: "SKYHAWK-A49 Tower", "Bobcat 7 morning practice".
   */
  roomName: string;
  /** Same value as `roomName`, kept distinct so future endpoints can flag user-chosen vs auto-derived. */
  name?: string | null;
  /** Cosmetic notional VHF aviation frequency, e.g. "118.300". Always populated. */
  frequencyMhz?: string | null;
  /** Session ATC callsign (e.g. DARWIN-A12). Distinct from `roomName`. */
  callsign?: string | null;
  status: string;
  pilotUserId: string | null;
  assignedTowerUserId?: string | null;
  towerPresent: boolean;
  /** How many users are currently listening as spectators. Public; no PII. */
  spectatorCount?: number;
  /** True when the caller is on this room's spectator list. Drives Spectate vs Leave button. */
  viewerIsSpectating?: boolean;
  /**
   * Server-computed membership for this room vs the current API principal (same
   * id as `GET /v1/me/active-room`). Prefer over comparing `pilotUserId` to
   * `user.id` — in dev open-auth those can differ (plugin vs web login payload).
   */
  callerMembership?: "pilot" | "controller" | "spectator" | null;
  messageCount: number;
  lastMessageAt?: string | null;
  updatedAt: string;
};

type LobbyRoomsResponse = {
  ok?: boolean;
  rooms?: RoomSummary[];
};

type QueueStatusResponse = {
  ok?: boolean;
  inQueue?: boolean;
  queueSize?: number;
};

type QueueMutationResponse = {
  ok?: boolean;
  queueSize?: number;
};

type Props = {
  user: AuthUser;
  /** Called by join flows so the App-level `useActiveRoom` poll refreshes immediately. */
  onRoomChanged?: () => void;
};

const ROOM_NAME_MAX = 80;
/** Lobby polls fast — these views are the user's "what's happening right now" surface. */
const LOBBY_POLL_MS = 2_500;

/**
 * Roles that conceptually sit in the tower seat, not the cockpit.
 */
function isControllerSeatRole(role: AuthUser["role"]): boolean {
  return role === "controller" || role === "mod" || role === "supermod" || role === "owner";
}

export function LobbyPage({ user, onRoomChanged }: Props): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  /** Same poll as the shell / route guard — use when per-room `callerMembership` is missing or wrong. */
  const activeRoom = useActiveRoomCached();
  const [draft, setDraft] = useState("");
  const [renameBusyId, setRenameBusyId] = useState<string | null>(null);
  const [roomActionBusyId, setRoomActionBusyId] = useState<string | null>(null);

  const [statusOverride, setStatusOverride] = useState<{ text: string; err: boolean } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  /** Pilot+ lobby listen to a room’s ops LiveKit mix without spectating `/tower`. */
  const [lobbyListenRoomId, setLobbyListenRoomId] = useState<string | null>(null);

  const isControllerSeat = isControllerSeatRole(user.role);
  const canDmFromLobby = !user.isGuest && userHasCapability(user, "chat:dm");

  const roomsQuery = useApiQuery<LobbyRoomsResponse>({
    queryKey: queryKeys.lobby.rooms,
    path: "/v1/lobby/rooms",
    refetchInterval: LOBBY_POLL_MS,
    placeholderData: (prev) => prev
  });
  const rooms = roomsQuery.data?.rooms ?? [];

  const messagesQuery = useApiQuery<LobbyMessagesResponse>({
    queryKey: queryKeys.lobby.messages,
    path: "/v1/lobby/messages",
    refetchInterval: LOBBY_POLL_MS,
    placeholderData: (prev) => prev
  });
  // The lobby chat backend is optional in some deployments. A 404 means
  // "feature not enabled" — render an empty state, don't show a scary error.
  const lobbyChatMissing = messagesQuery.error?.status === 404;
  const messages = messagesQuery.data?.messages ?? [];

  // Controller-queue status is only meaningful for users who actually sit in
  // the tower seat. Skipping the poll for pilots keeps the lobby quiet on the
  // network and avoids a useless every-5s GET that would always say
  // `inQueue: false` because pilots can't even join the queue.
  const queueStatusQuery = useApiQuery<QueueStatusResponse>({
    queryKey: queryKeys.lobby.queueStatus,
    path: "/v1/queue/status",
    enabled: isControllerSeat,
    refetchInterval: isControllerSeat ? LOBBY_POLL_MS * 2 : false,
    placeholderData: (prev) => prev
  });
  const queueInfo = queueStatusQuery.data;
  const isInQueue = !!queueInfo?.inQueue;
  const queueSize = queueInfo?.queueSize ?? 0;

  /**
   * `/tower` is gated on `GET /v1/me/active-room`. Invalidate-only + immediate
   * `navigate` raced the guard (one tick with stale cache → bounce to /lobby).
   * Await the refetch so server membership is visible before we route.
   */
  const reportLobbyVoiceError = useCallback((message: string) => {
    setStatusOverride({ err: true, text: `Tower audio: ${message}` });
  }, []);

  const goToTowerWorkspace = useCallback(
    async (roomId: string): Promise<void> => {
      rememberSession(roomId);
      await Promise.all([
        qc.refetchQueries({ queryKey: queryKeys.me.activeRoom }),
        qc.refetchQueries({ queryKey: queryKeys.lobby.rooms })
      ]);
      navigate("/tower");
    },
    [navigate, qc]
  );

  // Queue drain: when the backend assigns you as tower (e.g. next pilot /call),
  // `/me/active-room` flips to controller — take the user off the lobby into the
  // workspace without requiring a manual "Open" click.
  useEffect(() => {
    if (activeRoom?.myRole !== "controller") return;
    void goToTowerWorkspace(activeRoom.roomId);
  }, [activeRoom?.myRole, activeRoom?.roomId, goToTowerWorkspace]);

  const joinQueueMutation = useApiMutation<QueueMutationResponse, void>({
    mutationFn: () => apiCall<QueueMutationResponse>("/v1/queue/join", { method: "POST" }),
    invalidate: [queryKeys.lobby.queueStatus],
    onError: (err) => setStatusOverride({ err: true, text: `Could not join queue: ${err.message}` })
  });

  const leaveQueueMutation = useApiMutation<QueueMutationResponse, void>({
    mutationFn: () => apiCall<QueueMutationResponse>("/v1/queue/leave", { method: "POST" }),
    invalidate: [queryKeys.lobby.queueStatus],
    onError: (err) => setStatusOverride({ err: true, text: `Could not leave queue: ${err.message}` })
  });

  const renameRoomMutation = useApiMutation<unknown, { roomId: string; name: string | null }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(vars.roomId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: vars.name })
      }),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onError: (err) => setStatusOverride({ err: true, text: `Could not rename room: ${err.message}` })
  });

  // Spectate flow: POST /spectate then navigate to /tower. The route guard
  // (App.tsx -> activeRoomOnly) re-checks server truth via useActiveRoom, so we
  // must invalidate that cache and call onRoomChanged before navigating —
  // otherwise the guard sees "no active room" for one tick and bounces us back.
  const spectateMutation = useApiMutation<unknown, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(vars.roomId)}`.concat("/spectate"), {
        method: "POST"
      }),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onError: (err) => setStatusOverride({ err: true, text: `Could not spectate room: ${err.message}` })
  });

  const leaveSpectatorMutation = useApiMutation<unknown, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(vars.roomId)}`.concat("/leave"), {
        method: "POST"
      }),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onError: (err) => setStatusOverride({ err: true, text: `Could not leave room: ${err.message}` })
  });

  const closeRoomMutation = useApiMutation<unknown, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(vars.roomId)}`, {
        method: "DELETE"
      }),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onError: (err) => setStatusOverride({ err: true, text: `Could not close room: ${err.message}` })
  });

  // Mod-only "Kick tower" — vacates the tower seat without closing the room,
  // then optionally pulls in the next queued controller. Pilot stays put.
  // Returns the replacement user id (or null) so the toast can confirm whether
  // someone from the queue actually slid in.
  type ReleaseTowerResponse = {
    ok?: boolean;
    releasedUserId?: string | null;
    replacement?: string | null;
    alreadyVacant?: boolean;
  };
  const kickTowerMutation = useApiMutation<ReleaseTowerResponse, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall<ReleaseTowerResponse>(
        `/v1/session/${encodeURIComponent(vars.roomId)}/release-tower`,
        {
          method: "POST",
          body: JSON.stringify({ assignNext: true })
        }
      ),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onError: (err) =>
      setStatusOverride({ err: true, text: `Could not kick tower: ${err.message}` })
  });

  const sendLobbyMessageMutation = useApiMutation<unknown, { text: string }>({
    mutationFn: (vars) =>
      apiCall("/v1/lobby/messages", {
        method: "POST",
        body: JSON.stringify({ text: vars.text })
      }),
    invalidate: [queryKeys.lobby.messages],
    onSuccess: () => {
      setDraft("");
      setStatusOverride(null);
    },
    onError: (err) => {
      if (err.status === 404) {
        setStatusOverride({ err: true, text: "Lobby chat is not available on this backend." });
      } else {
        setStatusOverride({ err: true, text: `Could not send message: ${err.message}` });
      }
    }
  });

  // Compose a single status line: explicit override (mutation outcomes) wins
  // over the queries' own error states.
  const status: { text: string; err: boolean } | null = (() => {
    if (statusOverride) return statusOverride;
    if (roomsQuery.error && !roomsQuery.error.unreachable) {
      return { err: true, text: `Could not load rooms: ${roomsQuery.error.message}` };
    }
    if (messagesQuery.error && !messagesQuery.error.unreachable && !lobbyChatMissing) {
      return { err: true, text: `Could not load lobby chat: ${messagesQuery.error.message}` };
    }
    return null;
  })();

  function handleRename(roomId: string, currentName: string | null | undefined): void {
    const proposed = window.prompt("Rename this tower room (leave empty to clear):", currentName ?? "");
    if (proposed === null) return;
    const trimmed = proposed.trim().slice(0, ROOM_NAME_MAX);
    setRenameBusyId(roomId);
    setStatusOverride(null);
    renameRoomMutation.mutate(
      { roomId, name: trimmed.length > 0 ? trimmed : null },
      {
        onSettled: () => setRenameBusyId(null),
        onSuccess: () => {
          // Make sure the lobby reflects the new name on the very next paint,
          // before the polling interval fires again.
          void qc.invalidateQueries({ queryKey: queryKeys.lobby.rooms });
        }
      }
    );
  }

  function handleJoinQueue(): void {
    setStatusOverride(null);
    setQueueBusy(true);
    joinQueueMutation.mutate(undefined, {
      onSettled: () => setQueueBusy(false),
      onSuccess: (data) => {
        setStatusOverride({
          err: false,
          text: `Joined controller queue (${data?.queueSize ?? 1} waiting). You'll be auto-assigned to the next pilot's room.`
        });
      }
    });
  }

  function handleLeaveQueue(): void {
    setStatusOverride(null);
    setQueueBusy(true);
    leaveQueueMutation.mutate(undefined, {
      onSettled: () => setQueueBusy(false),
      onSuccess: () => {
        setStatusOverride({ err: false, text: "Left controller queue." });
      }
    });
  }

  function handleSend(): void {
    const text = draft.trim();
    if (!text) return;
    setStatusOverride(null);
    sendLobbyMessageMutation.mutate({ text });
  }


  function handleSpectate(roomId: string, roomName: string): void {
    setStatusOverride(null);
    setRoomActionBusyId(roomId);
    spectateMutation.mutate(
      { roomId },
      {
        onSettled: () => setRoomActionBusyId(null),
        onSuccess: async () => {
          await goToTowerWorkspace(roomId);
        },
        onError: (err) => {
          setStatusOverride({ err: true, text: `Could not spectate ${roomName}: ${err.message}` });
        }
      }
    );
  }

  function handleLeaveSpectator(roomId: string, roomName: string): void {
    setStatusOverride(null);
    setRoomActionBusyId(roomId);
    leaveSpectatorMutation.mutate(
      { roomId },
      {
        onSettled: () => setRoomActionBusyId(null),
        onSuccess: () => {
          // Clear any cached "current room" hint so the topbar pill / route
          // guard immediately reflect "not in a room" without waiting on the
          // poll. Server-truth /v1/me/active-room invalidation already happens
          // via the mutation config.
          rememberSession("");
          onRoomChanged?.();
          setStatusOverride({ err: false, text: `Stopped spectating ${roomName}.` });
        },
        onError: (err) => {
          setStatusOverride({ err: true, text: `Could not leave ${roomName}: ${err.message}` });
        }
      }
    );
  }

  function handleKickTower(roomId: string, roomName: string, towerUserId: string | null | undefined): void {
    const who = towerUserId ?? "this tower";
    const confirmed = window.confirm(
      `Remove ${who} from "${roomName}"? The pilot stays in the room and the next queued controller (if any) will be auto-assigned.`
    );
    if (!confirmed) return;
    setStatusOverride(null);
    setRoomActionBusyId(roomId);
    kickTowerMutation.mutate(
      { roomId },
      {
        onSettled: () => setRoomActionBusyId(null),
        onSuccess: (data) => {
          if (data?.alreadyVacant) {
            setStatusOverride({ err: false, text: `${roomName}: tower seat was already vacant.` });
            return;
          }
          if (data?.replacement) {
            setStatusOverride({
              err: false,
              text: `Kicked tower from ${roomName}. ${data.replacement} was pulled from the queue to take over.`
            });
          } else {
            setStatusOverride({
              err: false,
              text: `Kicked tower from ${roomName}. Seat is now empty (queue was empty too).`
            });
          }
        }
      }
    );
  }

  function handleClose(roomId: string, roomName: string): void {
    const confirmed = window.confirm(
      `Close "${roomName}"? Everyone in the room (including spectators) will be returned to the lobby. Chat history is preserved for audit.`
    );
    if (!confirmed) return;
    setStatusOverride(null);
    setRoomActionBusyId(roomId);
    closeRoomMutation.mutate(
      { roomId },
      {
        onSettled: () => setRoomActionBusyId(null),
        onSuccess: () => {
          rememberSession("");
          onRoomChanged?.();
          setStatusOverride({ err: false, text: `Closed ${roomName}.` });
        },
        onError: (err) => {
          setStatusOverride({ err: true, text: `Could not close ${roomName}: ${err.message}` });
        }
      }
    );
  }

  return (
    <>
      <LobbyOpsPlayback sessionId={lobbyListenRoomId} onStreamError={reportLobbyVoiceError} />
      <header className="page-header">
        <div>
          <h1>Lobby</h1>
          <p>
            Welcome, {user.displayName ?? user.email ?? user.id}. Pick an active tower room or open a new one.
          </p>
        </div>
      </header>

      {status ? <pre className={`msg ${status.err ? "error" : "ok"}`}>{status.text}</pre> : null}

      <div className="split-grid">
        <section className="card">
          <h2>Lobby text chat</h2>
          <div className="chat-log">
            {messages.length === 0 ? (
              <p className="chat-empty">
                {lobbyChatMissing ? "Lobby chat is not available on this backend." : "No lobby messages yet."}
              </p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="chat-line">
                  <div className="chat-meta">
                    {new Date(m.createdAt).toLocaleTimeString()} —{" "}
                    <LobbyDmUserId userId={m.fromUserId} selfId={user.id} canDm={canDmFromLobby} />
                  </div>
                  <div>{m.body}</div>
                </div>
              ))
            )}
          </div>
          <label htmlFor="lobby-draft" style={{ marginTop: "0.75rem" }}>
            Send to lobby
          </label>
          <textarea
            id="lobby-draft"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type lobby message..."
          />
          <div className="row">
            <button
              type="button"
              onClick={handleSend}
              disabled={sendLobbyMessageMutation.isPending || !draft.trim()}
            >
              {sendLobbyMessageMutation.isPending ? "Sending..." : "Send"}
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Radio channels</h2>
          </div>
          {isControllerSeat ? (
            <div
              className="row"
              style={{
                gap: "0.5rem",
                alignItems: "center",
                marginBottom: "0.75rem",
                flexWrap: "wrap"
              }}
            >
              <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: "0.9rem", color: "var(--muted)" }}>
                {isInQueue
                  ? `You're in the controller queue (${queueSize} waiting). Pilot calls now land on provisioned radio channels.`
                  : "Rooms are server-owned radio channels. Join the queue to take the next pilot call."}
              </span>
              {isInQueue ? (
                <button
                  type="button"
                  onClick={handleLeaveQueue}
                  disabled={queueBusy || leaveQueueMutation.isPending}
                  title="Leave the controller queue."
                >
                  {queueBusy || leaveQueueMutation.isPending ? "Leaving..." : "Leave queue"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleJoinQueue}
                  disabled={queueBusy || joinQueueMutation.isPending}
                  title="Join the controller queue and take the next pilot call."
                >
                  {queueBusy || joinQueueMutation.isPending ? "Joining..." : "Take next call"}
                </button>
              )}
            </div>
          ) : (
            <p className="chat-empty" style={{ marginBottom: "0.75rem" }}>
              Tune the in-game radio for pilot transmit. From the web you can listen to any provisioned channel below.
            </p>
          )}
          {rooms.length === 0 ? (
            <p className="chat-empty">No active tower rooms right now.</p>
          ) : (
            <div className="room-list">
              {rooms.map((room) => {
                // Prefer server `callerMembership` (same principal as every /v1/* call).
                // Fallback: old clients compared pilot/controller ids to `user.id`,
                // which breaks when dev open-auth bridges API userId to the plugin
                // but the React `user` object still holds the pre-bridge login id.
                const membership =
                  room.callerMembership ??
                  (room.viewerIsSpectating
                    ? ("spectator" as const)
                    : room.pilotUserId === user.id || room.assignedTowerUserId === user.id
                      ? room.pilotUserId === user.id
                        ? ("pilot" as const)
                        : ("controller" as const)
                      : null);
                const isThisActivePilotRoom =
                  activeRoom != null &&
                  activeRoom.roomId === room.roomId &&
                  activeRoom.myRole === "pilot";
                const isThisActiveTowerRoom =
                  activeRoom != null &&
                  activeRoom.roomId === room.roomId &&
                  activeRoom.myRole === "controller";
                const isMine =
                  membership === "pilot" ||
                  membership === "controller" ||
                  isThisActivePilotRoom ||
                  isThisActiveTowerRoom;
                const isAlreadySpectating =
                  (membership === "spectator" || !!room.viewerIsSpectating) && !isMine;
                const spectatorCount = room.spectatorCount ?? 0;
                const actionBusy = roomActionBusyId === room.roomId;
                const isServerRadioRoom = room.roomId.startsWith("ksc-radio-");
                const canClose = !isServerRadioRoom && (isMine || user.isMod === true);
                // Mod-only "Kick tower" — only meaningful when there's actually a
                // controller sitting in the seat AND it isn't the caller themselves
                // (the caller's own "leave seat" path is the in-room "Stand down"
                // banner, not a self-kick from the lobby card).
                const canKickTower =
                  user.isMod === true &&
                  !!room.assignedTowerUserId &&
                  room.assignedTowerUserId !== user.id;
                return (
                  <article
                    key={room.roomId}
                    className={"room-item" + (isMine ? " room-item-mine" : "")}
                  >
                    <div className="room-main">
                      <strong>{room.roomName}</strong>
                      {room.callsign?.trim() ? (
                        <span className="atc-session-callsign room-pill" title={CALLSIGN_DISPLAY_HELP}>
                          {room.callsign.trim()}
                        </span>
                      ) : null}
                      {room.frequencyMhz ? (
                        <span
                          className="room-pill"
                          title="Server-owned radio frequency"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {displayMhzFromCanonical(room.frequencyMhz)} MHz
                        </span>
                      ) : null}
                      <span className="room-pill">{room.status}</span>
                      {isMine ? (
                        <span
                          className="room-pill"
                          style={{ background: "var(--accent)", color: "#000" }}
                          title="You are pilot or assigned controller of this room"
                        >
                          YOURS
                        </span>
                      ) : null}
                      {isAlreadySpectating ? (
                        <span
                          className="room-pill"
                          title="You are listening to this room as a read-only spectator"
                        >
                          SPECTATING
                        </span>
                      ) : null}
                      {spectatorCount > 0 ? (
                        <span
                          className="room-pill"
                          title={`${spectatorCount} listener${spectatorCount === 1 ? "" : "s"}`}
                        >
                          {spectatorCount} listening
                        </span>
                      ) : null}
                    </div>
                    <div className="room-meta">
                      Tower:{" "}
                      {room.assignedTowerUserId ? (
                        <LobbyDmUserId
                          userId={room.assignedTowerUserId}
                          selfId={user.id}
                          canDm={canDmFromLobby}
                        />
                      ) : (
                        "unassigned"
                      )}{" "}
                      — Pilot:{" "}
                      {room.pilotUserId ? (
                        <LobbyDmUserId userId={room.pilotUserId} selfId={user.id} canDm={canDmFromLobby} />
                      ) : (
                        "—"
                      )}
                    </div>
                    <div className="room-meta">
                      Messages: {room.messageCount} - Updated {new Date(room.updatedAt).toLocaleTimeString()}
                    </div>
                    <div className="row">
                      {isMine ? (
                        <button
                          type="button"
                          onClick={() => {
                            void goToTowerWorkspace(room.roomId);
                          }}
                        >
                          Open
                        </button>
                      ) : isAlreadySpectating ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              void goToTowerWorkspace(room.roomId);
                            }}
                          >
                            Open (listen only)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleLeaveSpectator(room.roomId, room.roomName)}
                            disabled={actionBusy}
                            title="Stop listening to this room"
                          >
                            {actionBusy ? "Leaving..." : "Leave"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSpectate(room.roomId, room.roomName)}
                          disabled={actionBusy || user.isGuest === true}
                          title={
                            user.isGuest
                              ? "Guests can't spectate tower rooms — sign in to listen."
                            : isServerRadioRoom
                              ? "Tune in to this server-owned radio channel"
                              : "Listen to this room as a read-only spectator (chat / kOS / voice subscribe-only)"
                          }
                        >
                          {actionBusy ? "Joining..." : isServerRadioRoom ? "Tune in" : "Spectate"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRename(room.roomId, room.name ?? null)}
                        disabled={renameBusyId === room.roomId || !isMine || isServerRadioRoom}
                        title={
                          isServerRadioRoom
                            ? "Server-owned radio channel names are fixed"
                            : isMine
                            ? "Rename this room"
                            : "Only the pilot, assigned controller, or a mod can rename"
                        }
                      >
                        {renameBusyId === room.roomId ? "Renaming..." : "Rename"}
                      </button>
                      {!user.isGuest ? (
                        <button
                          type="button"
                          onClick={() => {
                            setStatusOverride(null);
                            setLobbyListenRoomId((cur) => (cur === room.roomId ? null : room.roomId));
                          }}
                          disabled={actionBusy}
                          title={
                            lobbyListenRoomId === room.roomId
                              ? "Stop playing this room’s tower voice in the lobby."
                              : "Play this room’s tower voice while you stay in the lobby (receive-only)."
                          }
                        >
                          {lobbyListenRoomId === room.roomId ? "Stop tower audio" : "Hear tower audio"}
                        </button>
                      ) : null}
                      {canKickTower ? (
                        <button
                          type="button"
                          onClick={() =>
                            handleKickTower(
                              room.roomId,
                              room.roomName,
                              room.assignedTowerUserId ?? null
                            )
                          }
                          disabled={actionBusy}
                          title="Mod action: remove the current tower from this room. The pilot stays; the next queued controller (if any) is auto-assigned."
                        >
                          {actionBusy ? "Kicking..." : "Kick tower"}
                        </button>
                      ) : null}
                      {canClose ? (
                        <button
                          type="button"
                          onClick={() => handleClose(room.roomId, room.roomName)}
                          disabled={actionBusy}
                          title={
                            isMine
                              ? "Close this room — everyone (including spectators) is returned to the lobby"
                              : "Mod action: close this room and return everyone to the lobby"
                          }
                        >
                          {actionBusy ? "Closing..." : "Close"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}





