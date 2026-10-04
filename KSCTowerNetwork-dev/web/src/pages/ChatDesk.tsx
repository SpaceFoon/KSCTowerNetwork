import { useEffect, useRef, useState } from "react";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { formatApiError } from "../session/formatApiError";
import { useActiveRoomCached } from "../session/useActiveRoom";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";

type SessionMessage = {
  id: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type MessagesRes = { ok?: boolean; messages?: SessionMessage[] };

const MESSAGE_POLL_MS = 2_500;

/** Prefer human sender from body for tower template lines (matches in-game ACARS header). */
function acarsHeaderFrom(m: SessionMessage): string {
  const b = (m.body ?? "").trim();
  const req = "[REQUEST] ";
  const reqTail = " ready for countdown";
  if (b.startsWith(req) && b.endsWith(reqTail)) {
    const mid = b.slice(req.length, b.length - reqTail.length).trim();
    if (mid) return mid;
  }
  const al = "[ALERT] ";
  const alTail = " requests takeoff clearance";
  if (b.startsWith(al) && b.endsWith(alTail)) {
    const mid = b.slice(al.length, b.length - alTail.length).trim();
    if (mid) return mid;
  }
  const abort = "[COUNTDOWN] POST-LIFTOFF ABORT (";
  if (b.startsWith(abort) && b.endsWith(")")) {
    const mid = b.slice(abort.length, b.length - 1).trim();
    if (mid) return mid;
  }
  return m.fromUserId || "?";
}

type ChatDeskProps = {
  /** Hide the page hero — use when embedding in TowerWall. */
  embedInWall?: boolean;
};

export function ChatDesk({ embedInWall }: ChatDeskProps = {}): JSX.Element {
  // No `dev-shared` fallback: when there's no stored session id, the parent
  // route guard (`activeRoomOnly` in App.tsx) has already redirected to /lobby,
  // so reaching this component implies a real session. Listen for cross-tab
  // changes so the desk follows along when the user joins a different room
  // from another tab.
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? "");
  useEffect(() => {
    lastMessageIdRef.current = "";
  }, [sessionId]);

  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key !== SESSION_STORAGE_KEY) return;
      setSessionId(e.newValue?.trim() ?? "");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const [draft, setDraft] = useState("");
  const qc = useQueryClient();
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const logRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string>("");
  // Spectators can read messages but the backend will 403 any POST /messages
  // (the chat:session capability is gated to participants). Disable the
  // composer up-front so they don't type a message that gets rejected on send.
  const activeRoom = useActiveRoomCached();
  const isSpectator = activeRoom?.myRole === "spectator";

  const messagesQuery = useApiQuery<MessagesRes>({
    queryKey: queryKeys.session.messages(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/messages`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? MESSAGE_POLL_MS : false,
    placeholderData: (prev) => prev
  });
  const lines = messagesQuery.data?.messages ?? [];
  const lastSync = messagesQuery.dataUpdatedAt
    ? new Date(messagesQuery.dataUpdatedAt).toLocaleTimeString()
    : "";

  const sendMutation = useApiMutation<unknown, { text: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: vars.text })
      }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: queryKeys.session.messages(sessionId) });
    }
  });

  // Auto-scroll when the log actually grows and the reader is already near the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (!el || lines.length === 0) {
      return;
    }
    const tailId = lines[lines.length - 1]!.id;
    const grew = tailId !== lastMessageIdRef.current;
    lastMessageIdRef.current = tailId;
    if (!grew) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [lines]);

  function send(): void {
    const text = draft.trim();
    if (!text) return;
    sendMutation.mutate({ text });
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Compose status: send error wins (most actionable), then fetch error.
  const status: { text: string; err: boolean } | null = (() => {
    if (sendMutation.error) {
      const msg = `${formatApiError(sendMutation.error.status, sendMutation.error.message, "send")}\n${JSON.stringify(sendMutation.error.body, null, 2)}`;
      return { err: true, text: msg };
    }
    if (messagesQuery.error && !messagesQuery.error.unreachable) {
      const msg = formatApiError(messagesQuery.error.status, messagesQuery.error.message, "messages");
      return { err: true, text: `${msg}\n${JSON.stringify(messagesQuery.error.body, null, 2)}` };
    }
    return null;
  })();

  const body = (
    <div className="card">
        <div className="card-head">
          <h2>Messages</h2>
          {lastSync ? (
            <span className="chat-meta" aria-live="polite">
              Live · last sync {lastSync}
            </span>
          ) : null}
        </div>
        {status ? (
          <pre className={`msg ${status.err ? "error" : "ok"}`} style={{ margin: "0 0 0.55rem" }}>{status.text}</pre>
        ) : null}
        <div className={"chat-log" + (embedInWall ? " chat-log--embed" : "")} ref={logRef}>
          {lines.length === 0 ? (
            <p className="chat-empty">No messages yet.</p>
          ) : (
            lines.map((m) => (
              <div key={m.id} className="chat-line">
                <div className="chat-meta">
                  {new Date(m.createdAt).toLocaleTimeString()} — {acarsHeaderFrom(m)}
                </div>
                <div>{m.body}</div>
              </div>
            ))
          )}
        </div>
        <label htmlFor="draft" style={{ marginTop: "0.75rem" }}>
          Send ACARS
        </label>
        <textarea
          id="draft"
          rows={2}
          value={isSpectator ? "" : draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          disabled={isSpectator}
          placeholder={
            isSpectator
              ? "Spectators can't transmit on ACARS — leave the room to take a participant slot."
              : "Links, coordinates, or text when voice isn’t an option — Enter to send, Shift+Enter for newline."
          }
        />
        <div className="row">
          <button
            type="button"
            onClick={send}
            disabled={sendMutation.isPending || !draft.trim() || !sessionId || isSpectator}
            title={isSpectator ? "Spectators are read-only on ACARS." : undefined}
          >
            {sendMutation.isPending ? "Sending…" : isSpectator ? "Read-only" : "Send"}
          </button>
        </div>
      </div>
  );

  if (embedInWall) {
    return (
      <div className="tower-wall-embed-desk tower-wall-embed-desk--acars">
        {body}
      </div>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>ACARS</h1>
          <p>
            Links, coordinates, and when voice isn&apos;t an option — same session as tower voice (permissions
            match).
          </p>
        </div>
        {sessionId ? (
          <div className="page-header-id" title={`Linked to session ${sessionId}`}>
            room <code>{sessionId}</code>
          </div>
        ) : null}
      </header>
      {body}
    </>
  );
}
