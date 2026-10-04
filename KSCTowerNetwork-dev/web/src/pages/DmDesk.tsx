import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthUser, Role } from "../auth/session";
import { markDmPeerRead } from "../dm/dmReadStore";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { formatApiError } from "../session/formatApiError";

/**
 * 1:1 ACARS between two authenticated web/plugin users. Uses the dedicated
 * `/v1/dm/*` endpoints, which under the hood store messages in the same
 * `session_messages` table as session chat (synthetic `dm:<lo>|<hi>` thread
 * id), so DM history survives a backend restart the same way session chat
 * does — no separate migration.
 *
 * UX shape: classic two-pane layout. Left rail lists known peers with the
 * most recent message preview at the top; right pane is the conversation
 * with the selected peer plus a composer. Polling is now driven by TanStack
 * Query — the messages list refetches every 3s while a peer is selected,
 * the thread list every 6s, and the peer roster every 30s.
 */

type SessionMessage = {
  id: string;
  sessionId: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type Peer = {
  userId: string;
  displayName: string;
  email?: string;
  role?: Role;
};

type Thread = {
  peerUserId: string;
  lastMessage?: SessionMessage;
};

type PeersRes = { ok?: boolean; peers?: Peer[] };
type ThreadsRes = { ok?: boolean; threads?: Thread[] };
type MessagesRes = { ok?: boolean; peerUserId?: string; messages?: SessionMessage[] };

const DM_PEER_STORAGE_KEY = "ksc_tower_dm_peer";

const MESSAGE_POLL_MS = 3_000;
const THREAD_POLL_MS = 6_000;
const PEER_REFRESH_MS = 30_000;

type Props = { user: AuthUser };

export function DmDesk({ user }: Props): JSX.Element {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedPeerId, setSelectedPeerId] = useState<string>(() => {
    try {
      return localStorage.getItem(DM_PEER_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const peersQuery = useApiQuery<PeersRes>({
    queryKey: queryKeys.dm.peers,
    path: "/v1/dm/peers",
    refetchInterval: PEER_REFRESH_MS,
    placeholderData: (prev) => prev
  });
  const peers = peersQuery.data?.peers ?? [];

  const threadsQuery = useApiQuery<ThreadsRes>({
    queryKey: queryKeys.dm.threads,
    path: "/v1/dm/threads",
    refetchInterval: THREAD_POLL_MS,
    placeholderData: (prev) => prev
  });
  const threads = threadsQuery.data?.threads ?? [];

  const messagesQuery = useApiQuery<MessagesRes>({
    queryKey: queryKeys.dm.messages(selectedPeerId),
    path: `/v1/dm/${encodeURIComponent(selectedPeerId)}/messages`,
    enabled: !!selectedPeerId,
    refetchInterval: selectedPeerId ? MESSAGE_POLL_MS : false,
    placeholderData: (prev) => prev,
    // The route stamps `peerUserId` on the response so a stale poll for a
    // previous peer can be ignored. Using `select` runs this on every render
    // — cheap and keeps the UI from flickering the wrong conversation.
    select: (data) => {
      if (data.peerUserId && data.peerUserId !== selectedPeerId) {
        return { ...data, messages: [] };
      }
      return data;
    }
  });
  const messages = messagesQuery.data?.messages ?? [];
  const lastSync = messagesQuery.dataUpdatedAt
    ? new Date(messagesQuery.dataUpdatedAt).toLocaleTimeString()
    : "";

  const sendMutation = useApiMutation<unknown, { text: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/dm/${encodeURIComponent(selectedPeerId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: vars.text })
      }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: queryKeys.dm.messages(selectedPeerId) });
      void qc.invalidateQueries({ queryKey: queryKeys.dm.threads });
    }
  });

  const peerById = useMemo(() => {
    const m = new Map<string, Peer>();
    for (const p of peers) m.set(p.userId, p);
    return m;
  }, [peers]);

  const railEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ peer: Peer; lastMessage?: SessionMessage }> = [];
    for (const t of threads) {
      const peer = peerById.get(t.peerUserId) ?? {
        userId: t.peerUserId,
        displayName: t.peerUserId
      };
      entries.push({ peer, lastMessage: t.lastMessage });
      seen.add(t.peerUserId);
    }
    for (const p of peers) {
      if (!seen.has(p.userId)) {
        entries.push({ peer: p });
      }
    }
    return entries;
  }, [threads, peers, peerById]);

  const persistSelectedPeer = useCallback((id: string) => {
    setSelectedPeerId(id);
    try {
      if (id) localStorage.setItem(DM_PEER_STORAGE_KEY, id);
      else localStorage.removeItem(DM_PEER_STORAGE_KEY);
    } catch {
      // private mode; harmless to ignore
    }
  }, []);

  // Deep-link from lobby (and elsewhere): /dm?peer=<userId>
  useEffect(() => {
    const raw = searchParams.get("peer");
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) return;
    const next = new URLSearchParams(searchParams);
    next.delete("peer");
    setSearchParams(next, { replace: true });
    if (id === user.id || id.startsWith("guest_")) return;
    persistSelectedPeer(id);
  }, [searchParams, setSearchParams, user.id, persistSelectedPeer]);

  // Stick to the bottom on new messages — but only when the user is already
  // near the bottom, so reading older history isn't yanked away by a poll.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Mark the open conversation as read up to the latest message we've fetched.
  // This drives the topbar DM badge in AppShell — opening a peer clears their
  // unread state, and any subsequent inbound message while the pane is open
  // is implicitly read on the next poll. Falls back to "now" when the thread
  // is empty so simply selecting a peer with no history clears the badge.
  const latestMessageAt =
    messages.length > 0 ? (messages[messages.length - 1]?.createdAt ?? null) : null;
  useEffect(() => {
    if (!selectedPeerId) return;
    markDmPeerRead(selectedPeerId, latestMessageAt ?? undefined);
  }, [selectedPeerId, latestMessageAt]);

  function send(): void {
    const text = draft.trim();
    if (!text || !selectedPeerId) return;
    sendMutation.mutate({ text });
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const selectedPeer =
    peerById.get(selectedPeerId) ??
    (selectedPeerId
      ? { userId: selectedPeerId, displayName: selectedPeerId }
      : undefined);

  // Render error preference: send mutation > messages fetch.
  const status: { text: string; err: boolean } | null = (() => {
    if (sendMutation.error) {
      return {
        err: true,
        text: `${formatApiError(sendMutation.error.status, sendMutation.error.message, "send")}\n${JSON.stringify(sendMutation.error.body, null, 2)}`
      };
    }
    if (messagesQuery.error && !messagesQuery.error.unreachable) {
      return {
        err: true,
        text: formatApiError(messagesQuery.error.status, messagesQuery.error.message, "dm")
      };
    }
    return null;
  })();

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Direct messages</h1>
          <p>
            Private one-on-one chat with another tower or pilot. Your conversation history is
            saved, so you can pick up where you left off. Signed in as{" "}
            <code>{user.displayName ?? user.id}</code>.
          </p>
        </div>
      </header>

      <div className="card" style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1rem" }}>
        <aside aria-label="Direct message peers" style={{ borderRight: "1px solid var(--border, #2a3140)", paddingRight: "0.75rem" }}>
          <div className="card-head" style={{ marginBottom: "0.5rem" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Conversations</h2>
          </div>
          {railEntries.length === 0 ? (
            <p className="chat-empty" style={{ marginTop: "0.5rem" }}>
              {user.role === "owner" || user.role === "supermod" ? (
                <>
                  No one to message yet. Add other users in <code>WEB_LOGIN_USERS_JSON</code>{" "}
                  on the backend to make them available here.
                </>
              ) : (
                <>No one to message yet. Ask your network admin to add other pilots or towers.</>
              )}
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {railEntries.map(({ peer, lastMessage }) => {
                const isActive = peer.userId === selectedPeerId;
                const previewWho =
                  lastMessage?.fromUserId === user.id ? "you" : peer.displayName;
                return (
                  <li key={peer.userId}>
                    <button
                      type="button"
                      onClick={() => persistSelectedPeer(peer.userId)}
                      className="dm-peer-button"
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "0.45rem 0.55rem",
                        borderRadius: "0.4rem",
                        background: isActive ? "var(--accent-soft, #1f2a3d)" : "transparent",
                        border: isActive ? "1px solid var(--accent, #3b6ea5)" : "1px solid transparent",
                        color: "inherit",
                        cursor: "pointer"
                      }}
                      aria-pressed={isActive}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                        <strong>{peer.displayName}</strong>
                        {peer.role ? (
                          <span className={`role-pill role-${peer.role}`} style={{ fontSize: "0.7rem", opacity: 0.8 }}>
                            {peer.role}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: "0.15rem" }}>
                        {lastMessage ? (
                          <>
                            <span>{previewWho}:</span>{" "}
                            <span>{truncate(lastMessage.body, 60)}</span>
                          </>
                        ) : (
                          <em>No messages yet</em>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section aria-label="Conversation">
          {selectedPeer ? (
            <>
              <div className="card-head" style={{ marginBottom: "0.5rem" }}>
                <h2 style={{ margin: 0 }}>
                  {selectedPeer.displayName}{" "}
                  <span style={{ fontSize: "0.8rem", opacity: 0.6 }}>({selectedPeer.userId})</span>
                </h2>
                {lastSync ? (
                  <span className="chat-meta" aria-live="polite">
                    Live · last sync {lastSync}
                  </span>
                ) : null}
              </div>
              <div className="chat-log" ref={logRef} style={{ minHeight: "320px" }}>
                {messages.length === 0 ? (
                  <p className="chat-empty">No messages yet — say hi.</p>
                ) : (
                  messages.map((m) => {
                    const mine = m.fromUserId === user.id;
                    return (
                      <div key={m.id} className="chat-line">
                        <div className="chat-meta">
                          {new Date(m.createdAt).toLocaleTimeString()} —{" "}
                          {mine ? "you" : selectedPeer.displayName}
                        </div>
                        <div>{m.body}</div>
                      </div>
                    );
                  })
                )}
              </div>
              {status ? (
                <pre className={`msg ${status.err ? "error" : "ok"}`} style={{ marginTop: "0.5rem" }}>
                  {status.text}
                </pre>
              ) : null}
              <label htmlFor="dm-draft" style={{ marginTop: "0.75rem" }}>
                Send DM to {selectedPeer.displayName}
              </label>
              <textarea
                id="dm-draft"
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder="Direct message — Enter to send, Shift+Enter for newline."
              />
              <div className="row">
                <button type="button" onClick={send} disabled={sendMutation.isPending || !draft.trim()}>
                  {sendMutation.isPending ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          ) : (
            <p className="chat-empty">Select a peer on the left to start a conversation.</p>
          )}
        </section>
      </div>
    </>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
