import { useEffect, useRef } from "react";
import { ConnectionState } from "livekit-client";
import { connectVoiceRoom, requestLiveKitToken, type VoiceRoomHandle } from "../voice/livekit";

type Props = {
  /** When non-null, subscribes to that session’s ops LiveKit mix (receive-only). */
  sessionId: string | null;
  onStreamError?: (message: string) => void;
};

/**
 * Hidden LiveKit subscriber used from the lobby so pilot-tier users can hear the
 * tower ops mix without joining the session roster or opening `/tower`.
 */
export function LobbyOpsPlayback({ sessionId, onStreamError }: Props): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<VoiceRoomHandle | null>(null);
  const seqRef = useRef(0);
  const onErrRef = useRef(onStreamError);
  onErrRef.current = onStreamError;

  useEffect(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    const mount = mountRef.current;

    const teardown = (): void => {
      handleRef.current?.disconnect();
      handleRef.current = null;
    };

    teardown();

    const trimmed = sessionId?.trim() ?? "";
    if (!trimmed || !mount) {
      return () => {
        teardown();
      };
    }

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      const tokenRes = await requestLiveKitToken(trimmed, "lobby_ops", controller.signal);
      if (cancelled || seq !== seqRef.current) return;
      if (!tokenRes.ok) {
        onErrRef.current?.(tokenRes.message);
        return;
      }
      const { token, wsUrl, canPublish, canSubscribe } = tokenRes.data;
      if (!canSubscribe) {
        onErrRef.current?.("Listen-only token missing subscribe grant.");
        return;
      }
      try {
        const handle = await connectVoiceRoom({
          wsUrl,
          token,
          canPublish,
          audioContainer: mount,
          onConnectionState: (_s: ConnectionState) => {
            /* lobby has no status UI */
          },
          onParticipants: () => {
            /* no roster in lobby */
          },
          onError: (message) => onErrRef.current?.(message)
        });
        if (cancelled || seq !== seqRef.current) {
          handle.disconnect();
          return;
        }
        handleRef.current = handle;
      } catch (e) {
        if (!cancelled && seq === seqRef.current) {
          onErrRef.current?.(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      teardown();
    };
  }, [sessionId]);

  return (
    <div
      ref={mountRef}
      style={{
        position: "absolute",
        width: 0,
        height: 0,
        overflow: "hidden",
        clipPath: "inset(50%)"
      }}
      aria-hidden
    />
  );
}
