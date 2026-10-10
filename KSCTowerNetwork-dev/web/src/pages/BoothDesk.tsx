import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { userHasCapability } from "../auth/session";
import { useAuthMe } from "../auth/useAuthMe";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { formatApiError } from "../session/formatApiError";
import { useActiveRoomCached } from "../session/useActiveRoom";
import { connectVoiceRoom, requestLiveKitToken, type VoiceRoomHandle } from "../voice/livekit";
import type { VoiceErrorKind, VoiceParticipantRow } from "../voice/types";

/**
 * Booth desk: spectator commentary channel that runs in parallel to the ops
 * channel. Visible to anyone in the room except the pilot — spectators chatter
 * here, the assigned tower controller is the only seat that can see/hear both
 * sides, and a moderator (assigned tower / mod+) can flip a kill-switch to
 * mute the entire booth.
 *
 * The booth's chat thread lives at `POST /v1/session/:id/booth/messages`
 * (synthetic `booth:<sid>` storage id) and the voice room is `tower-<sid>-booth`.
 * Both surfaces are gated by the same backend membership check.
 */
type BoothMessage = {
  id: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type BoothMessagesResponse = {
  ok?: boolean;
  messages?: BoothMessage[];
  /** Backend-reported booth kill-switch state. Mirrors `useActiveRoom().boothMuted`. */
  boothMuted?: boolean;
  /** Caller's resolved role inside the booth — either "moderator" or "spectator". */
  myBoothRole?: "moderator" | "spectator";
};

const BOOTH_POLL_MS = 2_500;

function errorKindLabel(kind: VoiceErrorKind): string {
  switch (kind) {
    case "permission_denied":
      return "Microphone blocked";
    case "no_token":
      return "Missing session";
    case "forbidden":
      return "Not allowed";
    case "not_found":
      return "Session not found";
    case "livekit_unavailable":
      return "LiveKit not configured";
    case "network":
      return "Connection error";
    default:
      return "Error";
  }
}

export function BoothDesk(): JSX.Element | null {
  const auth = useAuthMe();
  const user = auth.user;
  const activeRoom = useActiveRoomCached();
  const qc = useQueryClient();

  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? ""
  );
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key !== SESSION_STORAGE_KEY) return;
      setSessionId(e.newValue?.trim() ?? "");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Voice (booth room) connection state — kept entirely separate from the ops
  // VoiceDesk so the controller can be in both rooms simultaneously without
  // the two desks fighting over connection refs.
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceState, setVoiceState] = useState<ConnectionState | null>(null);
  const [voiceCaps, setVoiceCaps] = useState<{
    canPublish: boolean;
    canSubscribe: boolean;
    roomName: string;
  } | null>(null);
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipantRow[]>([]);
  const [voiceError, setVoiceError] = useState<{
    message: string;
    kind: VoiceErrorKind;
  } | null>(null);
  const [micMuted, setMicMuted] = useState(true);
  const [incomingLevel, setIncomingLevel] = useState(0);

  const voiceHandleRef = useRef<VoiceRoomHandle | null>(null);
  const unsubIncomingRef = useRef<(() => void) | null>(null);
  const audioMountRef = useRef<HTMLDivElement | null>(null);
  const voiceMicStreamRef = useRef<MediaStream | null>(null);
  const voiceConnectSeqRef = useRef(0);
  const voiceConnectAbortRef = useRef<AbortController | null>(null);

  const releaseVoiceMic = useCallback(() => {
    voiceMicStreamRef.current?.getTracks().forEach((t) => t.stop());
    voiceMicStreamRef.current = null;
  }, []);

  const disconnectVoice = useCallback(() => {
    voiceConnectSeqRef.current += 1;
    voiceConnectAbortRef.current?.abort();
    voiceConnectAbortRef.current = null;
    unsubIncomingRef.current?.();
    unsubIncomingRef.current = null;
    setIncomingLevel(0);
    voiceHandleRef.current?.disconnect();
    voiceHandleRef.current = null;
    releaseVoiceMic();
    setVoiceState(ConnectionState.Disconnected);
    setVoiceParticipants([]);
    setVoiceCaps(null);
    setVoiceConnecting(false);
    setMicMuted(true);
  }, [releaseVoiceMic]);

  // Tear down on unmount so leaving /tower doesn't leak the booth mic / RTC peer.
  useEffect(() => () => disconnectVoice(), [disconnectVoice]);

  const prevVoiceSessionRef = useRef(sessionId.trim());
  useEffect(() => {
    const id = sessionId.trim();
    const prev = prevVoiceSessionRef.current;
    if (prev === id) return;
    prevVoiceSessionRef.current = id;
    if (voiceConnecting || voiceState !== null || voiceHandleRef.current) {
      disconnectVoice();
    }
  }, [sessionId, voiceConnecting, voiceState, disconnectVoice]);

  // Chat poll. Driven by `enabled: !!sessionId` so we don't spam GETs before
  // the session id is available; the backend will 403 with `booth_denied` for
  // pilots and unauthorized callers, which we surface inline.
  const messagesQuery = useApiQuery<BoothMessagesResponse>({
    queryKey: queryKeys.session.boothMessages(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/booth/messages`,
    enabled: !!sessionId && !!user && activeRoom?.myRole !== "pilot",
    refetchInterval: sessionId ? BOOTH_POLL_MS : false,
    placeholderData: (prev) => prev
  });
  const messages = messagesQuery.data?.messages ?? [];
  const boothMuted = messagesQuery.data?.boothMuted ?? activeRoom?.boothMuted ?? false;
  const myBoothRole = messagesQuery.data?.myBoothRole;
  const lastSync = messagesQuery.dataUpdatedAt
    ? new Date(messagesQuery.dataUpdatedAt).toLocaleTimeString()
    : "";

  const isModerator =
    myBoothRole === "moderator" ||
    activeRoom?.myRole === "controller" ||
    (user ? user.isMod : false);
  const canModerate = userHasCapability(user, "booth:moderate");
  const canSendChat = userHasCapability(user, "chat:booth") && !(boothMuted && !isModerator);

  const [draft, setDraft] = useState("");
  const sendMutation = useApiMutation<unknown, { text: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/booth/messages`, {
        method: "POST",
        body: JSON.stringify({ text: vars.text })
      }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: queryKeys.session.boothMessages(sessionId) });
    }
  });

  const muteMutation = useApiMutation<unknown, { muted: boolean }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/booth/mute`, {
        method: "POST",
        body: JSON.stringify({ muted: vars.muted })
      }),
    invalidate: [
      queryKeys.session.boothMessages(sessionId),
      queryKeys.me.activeRoom
    ]
  });

  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // The pilot sees nothing here even if they somehow mount this component (the
  // parent route gate already hides it). 403 from the backend is treated as
  // "not in the booth" — render nothing instead of an angry error pane so the
  // ChatDesk grid stays clean for pilot-only rooms. Keep this after all hooks;
  // otherwise role/query flips violate React's hook ordering rules.
  if (activeRoom?.myRole === "pilot") return null;
  const fetch403 = messagesQuery.error?.status === 403;
  if (fetch403) return null;

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

  async function joinBoothVoice(): Promise<void> {
    const id = sessionId.trim();
    if (!id) {
      setVoiceError({ message: "Session id is required", kind: "no_token" });
      return;
    }
    voiceConnectAbortRef.current?.abort();
    const connectSeq = ++voiceConnectSeqRef.current;
    const controller = new AbortController();
    voiceConnectAbortRef.current = controller;
    const isStaleConnect = (): boolean =>
      connectSeq !== voiceConnectSeqRef.current || controller.signal.aborted;
    setVoiceError(null);
    setVoiceConnecting(true);
    setVoiceState(null);
    setVoiceParticipants([]);
    setVoiceCaps(null);

    const tokenRes = await requestLiveKitToken(id, "booth", controller.signal);
    if (isStaleConnect()) return;
    if (!tokenRes.ok) {
      setVoiceConnecting(false);
      setVoiceError({ message: tokenRes.message, kind: tokenRes.kind });
      return;
    }

    const { token, wsUrl, canPublish, canSubscribe, roomName } = tokenRes.data;
    setVoiceCaps({ canPublish, canSubscribe, roomName });

    const container = audioMountRef.current;
    if (!container) {
      setVoiceConnecting(false);
      setVoiceError({ message: "Booth audio container missing", kind: "unknown" });
      return;
    }

    let customMicTrack: MediaStreamTrack | undefined;
    if (canPublish) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
          video: false
        });
        if (isStaleConnect()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        voiceMicStreamRef.current = stream;
        customMicTrack = stream.getAudioTracks()[0];
      } catch (e) {
        releaseVoiceMic();
        setVoiceConnecting(false);
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setVoiceError({
            message: "Microphone permission denied",
            kind: "permission_denied"
          });
        } else {
          setVoiceError({
            message: e instanceof Error ? e.message : String(e),
            kind: "unknown"
          });
        }
        return;
      }
    }

    try {
      const handle = await connectVoiceRoom({
        wsUrl,
        token,
        canPublish,
        audioContainer: container,
        ...(customMicTrack ? { customMicTrack } : {}),
        onConnectionState: (s) => {
          setVoiceState(s);
          if (s === ConnectionState.Disconnected) {
            unsubIncomingRef.current?.();
            unsubIncomingRef.current = null;
            setIncomingLevel(0);
            voiceHandleRef.current = null;
            releaseVoiceMic();
            setVoiceConnecting(false);
          }
        },
        onParticipants: setVoiceParticipants,
        onError: (message, kind) => setVoiceError({ message, kind })
      });
      if (isStaleConnect()) {
        handle.disconnect();
        return;
      }
      voiceHandleRef.current = handle;
      unsubIncomingRef.current?.();
      unsubIncomingRef.current = null;
      // Match VoiceDesk: always wire the meter RAF. If the token denied subscribe,
      // there are no remote tracks and the bar stays at 0 — gating only on canSubscribe
      // hid the entire meter for edge cases (reconnect, caps timing).
      unsubIncomingRef.current = handle.subscribeIncomingLevel(setIncomingLevel);
      setVoiceState(handle.room.state);
      setVoiceConnecting(false);
      // Default to muted on join — booth voice should never go hot the second
      // someone clicks Connect.
      if (canPublish) {
        await handle.setMicEnabled(false);
        setMicMuted(true);
      }
      // Listen-only booth never opens getUserMedia; some browsers need another
      // explicit unlock pass so remote <audio> + our Web Audio meters see samples.
      void handle.room.startAudio().catch(() => {});
    } catch (e) {
      if (isStaleConnect()) return;
      releaseVoiceMic();
      setVoiceConnecting(false);
      voiceHandleRef.current = null;
      setVoiceError({
        message: e instanceof Error ? e.message : String(e),
        kind: "network"
      });
    } finally {
      if (voiceConnectAbortRef.current === controller) {
        voiceConnectAbortRef.current = null;
      }
    }
  }

  async function toggleMic(): Promise<void> {
    const h = voiceHandleRef.current;
    if (!h || !voiceCaps?.canPublish) return;
    const next = !micMuted;
    if (next) {
      await h.setMicEnabled(false);
      setMicMuted(true);
    } else {
      await h.setMicEnabled(true);
      setMicMuted(false);
    }
  }

  const voiceConnected = voiceState === ConnectionState.Connected;
  const voiceReconnecting =
    voiceState === ConnectionState.Reconnecting || voiceState === ConnectionState.SignalReconnecting;
  const voiceJoiningUi = voiceConnecting || voiceState === ConnectionState.Connecting;
  const anyBoothRemoteSpeaking = voiceParticipants.some((p) => !p.isLocal && p.isSpeaking);
  const effectiveIncomingLevel = Math.max(incomingLevel, anyBoothRemoteSpeaking ? 0.22 : 0);
  const boothIncomingPercent = Math.round(Math.min(1, effectiveIncomingLevel) * 100);
  const boothIncomingMeterActive = voiceConnected || voiceReconnecting;

  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h2>Booth (spectator commentary)</h2>
          <p style={{ margin: "0.15rem 0 0", color: "var(--muted)", fontSize: "0.85rem" }}>
            Side-channel chat &amp; voice for everyone in this room except the pilot.
            The assigned tower controller is the only seat that bridges both sides.
          </p>
        </div>
        {boothMuted ? (
          <span
            className="msg error"
            style={{
              margin: 0,
              padding: "0.25rem 0.6rem",
              fontWeight: 600,
              fontSize: "0.8rem",
              whiteSpace: "nowrap"
            }}
            role="status"
          >
            Booth muted
          </span>
        ) : null}
      </div>

      {canModerate ? (
        <div className="row" style={{ marginTop: "0.35rem", marginBottom: "0.6rem" }}>
          <button
            type="button"
            onClick={() => muteMutation.mutate({ muted: !boothMuted })}
            disabled={muteMutation.isPending}
            title={
              boothMuted
                ? "Unmute the booth — spectators can publish voice and post chat again."
                : "Mute the booth — spectator publish is revoked and chat is blocked until you unmute."
            }
          >
            {muteMutation.isPending
              ? "…"
              : boothMuted
                ? "Unmute booth"
                : "Mute booth"}
          </button>
          {muteMutation.error ? (
            <span className="msg error" style={{ margin: 0, padding: "0.25rem 0.5rem" }}>
              {muteMutation.error.message}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── Voice ───────────────────────────────────────────────────────── */}
      <div className="voice-client-strip" aria-label="Booth voice">
        <div
          ref={audioMountRef}
          aria-hidden
          style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
        />
        <div className="voice-status-row">
          <div
            className={
              "voice-status-pill " +
              (voiceConnected ? "connected" : voiceJoiningUi ? "connecting" : "disconnected")
            }
          >
            <span className="voice-status-dot" aria-hidden />
            {voiceConnected ? "Connected" : voiceJoiningUi ? "Connecting…" : "Disconnected"}
          </div>
          {voiceCaps?.roomName ? (
            <div className="voice-room-line">
              Booth room <code>{voiceCaps.roomName}</code>
            </div>
          ) : (
            <div className="voice-room-line">Join booth voice to talk to other spectators.</div>
          )}
        </div>

        <div className="voice-meter-wrap" style={{ marginTop: "0.5rem" }}>
          <span className="voice-meter-label">Incoming (spectators)</span>
          <div
            className="voice-meter-track"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={boothIncomingMeterActive ? boothIncomingPercent : 0}
          >
            <div
              className="voice-meter-fill"
              style={{ width: `${boothIncomingMeterActive ? boothIncomingPercent : 0}%` }}
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            className="voice-join-btn voice-join-toggle"
            onClick={() => {
              if (voiceConnected || voiceReconnecting) disconnectVoice();
              else void joinBoothVoice();
            }}
            disabled={
              !(voiceConnected || voiceReconnecting) && (!sessionId || voiceJoiningUi)
            }
            aria-pressed={voiceConnected || voiceReconnecting}
            title={
              voiceConnected || voiceReconnecting
                ? "Disconnect from booth voice"
                : !sessionId
                  ? "No active room"
                  : "Join the booth commentary channel"
            }
          >
            {voiceConnected || voiceReconnecting
              ? "Leave booth voice"
              : voiceJoiningUi
                ? "Joining…"
                : "Join booth voice"}
          </button>
          {voiceConnected && voiceCaps?.canPublish ? (
            <button
              type="button"
              className={"voice-mic-btn " + (micMuted ? "off" : "on")}
              onClick={() => void toggleMic()}
            >
              {micMuted ? "🔇 Mic off" : "🎤 Mic on"}
            </button>
          ) : null}
          {voiceConnected && !voiceCaps?.canPublish ? (
            <span className="voice-mic-hint">Listen-only (booth muted or no mic permission)</span>
          ) : null}
        </div>

        {voiceError ? (
          <pre className="msg error" style={{ marginTop: "0.5rem" }}>
            [{errorKindLabel(voiceError.kind)}] {voiceError.message}
          </pre>
        ) : null}

        {voiceConnected && voiceParticipants.length > 0 ? (
          <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
            {voiceParticipants.map((p) => (
              <li key={(p.isLocal ? "local:" : "remote:") + p.identity}>
                {p.isLocal ? <span style={{ color: "var(--muted)", marginRight: "0.35rem" }}>You</span> : null}
                <strong>{p.displayName || p.identity}</strong>
                {p.isSpeaking ? (
                  <span style={{ marginLeft: "0.5rem", color: "var(--ok)" }}>● speaking</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ── Chat ────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: "1rem" }}>
        <div className="card-head" style={{ marginBottom: "0.35rem" }}>
          <h3 style={{ margin: 0 }}>Chat</h3>
          {lastSync ? (
            <span className="chat-meta" aria-live="polite">
              Live · last sync {lastSync}
            </span>
          ) : null}
        </div>

        {messagesQuery.error && !messagesQuery.error.unreachable && messagesQuery.error.status !== 403 ? (
          <pre className="msg error" style={{ margin: "0 0 0.5rem" }}>
            {formatApiError(
              messagesQuery.error.status,
              messagesQuery.error.message,
              "messages"
            )}
          </pre>
        ) : null}
        {sendMutation.error ? (
          <pre className="msg error" style={{ margin: "0 0 0.5rem" }}>
            {formatApiError(sendMutation.error.status, sendMutation.error.message, "send")}
          </pre>
        ) : null}

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 ? (
            <p className="chat-empty">No booth chatter yet.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="chat-line">
                <div className="chat-meta">
                  {new Date(m.createdAt).toLocaleTimeString()} — {m.fromUserId}
                </div>
                <div>{m.body}</div>
              </div>
            ))
          )}
        </div>

        <label htmlFor="booth-draft" style={{ marginTop: "0.6rem" }}>
          Send to booth
        </label>
        <textarea
          id="booth-draft"
          rows={2}
          value={canSendChat ? draft : ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          disabled={!canSendChat}
          placeholder={
            !canSendChat
              ? boothMuted && !isModerator
                ? "Booth is muted by the tower."
                : "You don't have booth chat capability."
              : "Talk to other spectators (and the tower bridge) — Enter to send."
          }
        />
        <div className="row">
          <button
            type="button"
            onClick={send}
            disabled={sendMutation.isPending || !draft.trim() || !canSendChat}
          >
            {sendMutation.isPending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
