import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectionState } from "livekit-client";
import {
  createKerbalizerTrack,
  DEFAULT_KERBALIZER_PARAMS,
  KerbalizerControls,
  type KerbalizerHandle,
  type KerbalizerMeters,
  type KerbalizerParams
} from "../audio";
import { useAuthMe } from "../auth/useAuthMe";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { formatApiError } from "../session/formatApiError";
import { useActiveRoomCached } from "../session/useActiveRoom";
import { useLiveKitSessionCaps } from "../session/useLiveKitSessionCaps";
import {
  connectVoiceRoom,
  KSP_VOICE_BRIDGE_IDENTITY,
  requestLiveKitToken,
  type VoiceRoomHandle
} from "../voice/livekit";
import { pttGateMicOpen } from "../voice/pttGate";
import type { VoiceErrorKind, VoiceParticipantRow } from "../voice/types";
import { HullCamPanel } from "../components/HullCamPanel";
import { registerVoiceTopBar, resetVoiceTopBar } from "../voice/sessionVoiceTopBarBridge";
import { displayMhzFromCanonical } from "../lib/displayMhz";

function errorKindLabel(kind: VoiceErrorKind): string {
  switch (kind) {
    case "permission_denied":
      return "Microphone blocked";
    case "no_token":
      return "Missing session";
    case "forbidden":
      return "Not allowed (403)";
    case "not_found":
      return "Session not found (404)";
    case "livekit_unavailable":
      return "LiveKit not configured (503)";
    case "network":
      return "Connection error";
    default:
      return "Error";
  }
}

/** Web push-to-talk uses T so Space stays free for chat / page scroll. KSP uses its own bound key. */
const PTT_KEY_LABEL = "T";

function isPttKey(e: KeyboardEvent): boolean {
  if (e.code !== "KeyT") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Chrome/Chromium often outputs silence when a processed getUserMedia track
 * (echo cancellation / noise suppression) is piped through Web Audio into a
 * MediaStreamDestination for WebRTC. Disable those for the Kerbalizer send path;
 * Krisp covers noise when Kerbalizer is off.
 */
function publishMicConstraints(forWebAudioDsp: boolean): MediaTrackConstraints {
  if (forWebAudioDsp) {
    return {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true
    };
  }
  return { channelCount: 1, echoCancellation: true, noiseSuppression: true };
}

type VoiceDeskProps = {
  /** Hide page hero; trim extra cards  use inside TowerWall. */
  embedInWall?: boolean;
};

export function VoiceDesk({ embedInWall }: VoiceDeskProps = {}): JSX.Element {
  const [searchParams] = useSearchParams();
  const { user } = useAuthMe();
  const activeRoom = useActiveRoomCached();
  const isServerRadioRoom = activeRoom?.roomId.startsWith("ksc-radio-") === true;
  /** Ops voice from the browser is for the assigned tower; mods retain access; pilots use KSP + bridge. */
  const privilegedWebOps = Boolean(user?.isMod || user?.isAdmin || user?.isOwner);
  const canJoinTowerOpsVoice =
    isServerRadioRoom || activeRoom?.myRole === "controller" || privilegedWebOps;
  // Source of truth is whatever the App-level `useActiveRoom` poll wrote into
  // localStorage. We deliberately do NOT fall back to the `dev-shared` bootstrap
  // session anymore  that's how older builds let voice "look ready" while
  // talking into a permanently-empty LiveKit room. The /tower route guard
  // ensures we never mount without a real id.
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? ""
  );
  const [connecting, setConnecting] = useState(false);
  const [roomState, setRoomState] = useState<ConnectionState | null>(null);
  const [participants, setParticipants] = useState<VoiceParticipantRow[]>([]);
  const [lastError, setLastError] = useState<{ message: string; kind: VoiceErrorKind; status?: number } | null>(null);
  const [caps, setCaps] = useState<{
    canPublish: boolean;
    canSubscribe: boolean;
    roomName: string;
    sessionName?: string | null;
    frequencyMhz?: string | null;
  } | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  /** Latest mute flag for `applyCombinedPttMic` (refs avoid stale closures on bridge data packets). */
  const micMutedRef = useRef(micMuted);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [useKerbalizer, setUseKerbalizer] = useState(false);
  const [noiseCancellation, setNoiseCancellation] = useState(true);
  const [noiseCancellationActive, setNoiseCancellationActive] = useState(false);
  const [noiseCancellationSupported, setNoiseCancellationSupported] = useState(true);
  const [kerbalizerParams, setKerbalizerParams] = useState<KerbalizerParams>(DEFAULT_KERBALIZER_PARAMS);
  const [kerbalizerMeters, setKerbalizerMeters] = useState<KerbalizerMeters>({ input: 0, output: 0 });
  const [dspMode, setDspMode] = useState<KerbalizerHandle["mode"] | null>(null);

  const [pttHeld, setPttHeld] = useState(false);
  const [bridgePttActive, setBridgePttActive] = useState(false);

  const handleRef = useRef<VoiceRoomHandle | null>(null);
  const audioMountRef = useRef<HTMLDivElement | null>(null);
  const kerbalizerRef = useRef<KerbalizerHandle | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const meterUnsubRef = useRef<(() => void) | null>(null);
  const unsubIncomingRef = useRef<(() => void) | null>(null);
  const localMicMeterStopRef = useRef<(() => void) | null>(null);
  const localMicMeterStreamRef = useRef<MediaStream | null>(null);
  const localMicMeterTokenRef = useRef(0);
  const connectSeqRef = useRef(0);
  const connectAbortRef = useRef<AbortController | null>(null);
  const [incomingLevel, setIncomingLevel] = useState(0);
  const [localMicLevel, setLocalMicLevel] = useState(0);

  /** Mic is on only while T / pointer PTT is held, or KSP sent MIC_ON via the bridge (`ksp_ptt`). */
  const towerPttPhysicalRef = useRef(false);
  const bridgePttFromKspRef = useRef(false);
  const pttVoicePrefsRef = useRef({ canPublish: false });

  useEffect(() => {
    pttVoicePrefsRef.current = { canPublish: Boolean(caps?.canPublish) };
  }, [caps?.canPublish]);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  const persistSession = useCallback((id: string) => {
    setSessionId(id);
    if (id.trim()) {
      localStorage.setItem(SESSION_STORAGE_KEY, id.trim());
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const q = searchParams.get("session");
    if (q && q.trim()) {
      persistSession(q.trim());
    }
  }, [searchParams, persistSession]);

  // Keep the desk's session id in sync with whatever the App-level
  // `useActiveRoom` poll writes (room joins from the lobby, server kicks the
  // user out of a room, sign-out from another tab, etc).
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key !== SESSION_STORAGE_KEY) return;
      setSessionId(e.newValue?.trim() ?? "");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const releaseKerbalizerMic = useCallback(() => {
    meterUnsubRef.current?.();
    meterUnsubRef.current = null;
    kerbalizerRef.current?.dispose();
    kerbalizerRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setKerbalizerMeters({ input: 0, output: 0 });
    setDspMode(null);
  }, []);

  /** Tear down the active Kerbalizer wrapper but keep the raw mic stream alive  used when
   *  hot-toggling the Kerbalizer off mid-call so we can swap the published track back to raw. */
  const disposeKerbalizerOnly = useCallback(() => {
    meterUnsubRef.current?.();
    meterUnsubRef.current = null;
    kerbalizerRef.current?.dispose();
    kerbalizerRef.current = null;
    setKerbalizerMeters({ input: 0, output: 0 });
    setDspMode(null);
  }, []);

  /** Serializes hot mic-source swaps so a fast double-toggle can't race two
   *  `replaceTrack` calls against each other. */
  const kerbalizerSwapInFlightRef = useRef(false);

  const disconnect = useCallback(() => {
    connectSeqRef.current += 1;
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    unsubIncomingRef.current?.();
    unsubIncomingRef.current = null;
    localMicMeterStopRef.current?.();
    localMicMeterStopRef.current = null;
    localMicMeterStreamRef.current?.getTracks().forEach((t) => t.stop());
    localMicMeterStreamRef.current = null;
    setIncomingLevel(0);
    setLocalMicLevel(0);
    handleRef.current?.disconnect();
    handleRef.current = null;
    releaseKerbalizerMic();
    setRoomState(ConnectionState.Disconnected);
    setParticipants([]);
    setCaps(null);
    setConnecting(false);
    setMicMuted(false);
    micMutedRef.current = false;
    setPttHeld(false);
    towerPttPhysicalRef.current = false;
    bridgePttFromKspRef.current = false;
    setBridgePttActive(false);
  }, [releaseKerbalizerMic]);

  useEffect(
    // Run the same teardown the explicit Disconnect button uses on unmount; otherwise
    // navigating away while connected leaks the Kerbalizer worklet, AudioContext, and
    // mic track because `releaseKerbalizerMic()` and the meter unsubscribe were not
    // wired into the previous cleanup.
    () => () => {
      disconnect();
    },
    [disconnect]
  );

  const startLocalMicMeter = useCallback((track: MediaStreamTrack | undefined) => {
    const token = ++localMicMeterTokenRef.current;
    localMicMeterStopRef.current?.();
    localMicMeterStopRef.current = null;
    localMicMeterStreamRef.current?.getTracks().forEach((t) => t.stop());
    localMicMeterStreamRef.current = null;
    setLocalMicLevel(0);

    const setup = (meterTrack: MediaStreamTrack, ownedStream: MediaStream | null): void => {
      if (localMicMeterTokenRef.current !== token) {
        ownedStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      localMicMeterStreamRef.current = ownedStream;
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      void ctx.resume().catch(() => {});
      const stream = new MediaStream([meterTrack]);
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let raf = 0;
      const tick = (): void => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i] ?? 0;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLocalMicLevel(Math.min(1, rms * 4));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      localMicMeterStopRef.current = () => {
        cancelAnimationFrame(raf);
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
        void ctx.close().catch(() => {});
      };
    };

    if (track) {
      setup(track, null);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) return;
    void navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
      .then((stream) => {
        const t = stream.getAudioTracks()[0];
        if (!t) {
          stream.getTracks().forEach((x) => x.stop());
          return;
        }
        setup(t, stream);
      })
      .catch(() => {
        /* no fallback meter stream */
      });
  }, []);

  async function handleConnect(): Promise<void> {
    const id = sessionId.trim();
    if (!id) {
      setLastError({ message: "Session id is required", kind: "no_token" });
      return;
    }
    connectAbortRef.current?.abort();
    const connectSeq = ++connectSeqRef.current;
    const controller = new AbortController();
    connectAbortRef.current = controller;
    const isStaleConnect = (): boolean =>
      connectSeq !== connectSeqRef.current || controller.signal.aborted;
    setLastError(null);
    setPermissionDenied(false);
    setConnecting(true);
    setRoomState(null);
    setParticipants([]);
    setCaps(null);
    releaseKerbalizerMic();

    const tokenRes = await requestLiveKitToken(id, "ops", controller.signal);
    if (isStaleConnect()) return;
    if (!tokenRes.ok) {
      setConnecting(false);
      setLastError({ message: tokenRes.message, kind: tokenRes.kind, status: tokenRes.status });
      return;
    }

    const { token, wsUrl, canPublish, canSubscribe, roomName, sessionName, frequencyMhz } = tokenRes.data;
    setCaps({ canPublish, canSubscribe, roomName, sessionName, frequencyMhz });
    pttVoicePrefsRef.current = { canPublish };

    const container = audioMountRef.current;
    if (!container) {
      setConnecting(false);
      setLastError({ message: "Internal: audio container missing", kind: "unknown" });
      return;
    }

    let customMicTrack: MediaStreamTrack | undefined;

    if (canPublish) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: publishMicConstraints(useKerbalizer),
          video: false
        });
        if (isStaleConnect()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;
        const raw = stream.getAudioTracks()[0];
        if (!raw) {
          releaseKerbalizerMic();
          setConnecting(false);
          setLastError({ message: "No audio track from microphone", kind: "unknown" });
          return;
        }

        if (useKerbalizer) {
          const kh = await createKerbalizerTrack(raw, {
            initialParams: { ...kerbalizerParams, enabled: true }
          });
          kerbalizerRef.current = kh;
          setDspMode(kh.mode);
          meterUnsubRef.current = kh.subscribeMeters(setKerbalizerMeters);
          customMicTrack = kh.outputTrack;
        } else {
          customMicTrack = raw;
        }
      } catch (e) {
        releaseKerbalizerMic();
        setConnecting(false);
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setPermissionDenied(true);
          setLastError({ message: "Microphone permission denied", kind: "permission_denied" });
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          setLastError({ message: msg, kind: "unknown" });
        }
        return;
      }
    }

    try {
      towerPttPhysicalRef.current = false;
      bridgePttFromKspRef.current = false;

      const vh = await connectVoiceRoom({
        wsUrl,
        token,
        canPublish,
        audioContainer: container,
        customMicTrack,
        // Krisp expects a normal speech mic; on Kerbalizer output it often kills the send path.
        noiseCancellation: noiseCancellation && canPublish && !useKerbalizer,
        onBridgePtt: (on) => {
          bridgePttFromKspRef.current = on;
          setBridgePttActive(on);
          applyCombinedPttMic();
        },
        onNoiseCancellationStateChange: (enabled, supported) => {
          setNoiseCancellationActive(enabled);
          setNoiseCancellationSupported(supported);
        },
        onConnectionState: (s) => {
          setRoomState(s);
          if (s === ConnectionState.Disconnected) {
            unsubIncomingRef.current?.();
            unsubIncomingRef.current = null;
            setIncomingLevel(0);
            handleRef.current = null;
            releaseKerbalizerMic();
            setNoiseCancellationActive(false);
            setBridgePttActive(false);
            setConnecting(false);
          }
        },
        onParticipants: setParticipants,
        onError: (message, kind) => {
          if (kind === "permission_denied") {
            setPermissionDenied(true);
          }
          setLastError({ message, kind });
        }
      });
      if (isStaleConnect()) {
        vh.disconnect();
        return;
      }
      handleRef.current = vh;
      unsubIncomingRef.current?.();
      unsubIncomingRef.current = vh.subscribeIncomingLevel(setIncomingLevel);
      startLocalMicMeter(vh.getLocalMicMediaStreamTrack());
      setRoomState(vh.room.state);
      setConnecting(false);

      if (canPublish) {
        setMicMuted(true);
        micMutedRef.current = true;
        await vh.setMicEnabled(false);
      }
    } catch (e) {
      if (isStaleConnect()) return;
      releaseKerbalizerMic();
      setConnecting(false);
      handleRef.current = null;
      const msg = e instanceof Error ? e.message : String(e);
      const hint =
        /failed to fetch|network/i.test(msg) || msg.includes("fetch")
          ? " Often means the browser cannot open the LiveKit WebSocket: fix backend LIVEKIT_WS_URL (or LIVEKIT_URL) to your real wss://<project>.livekit.cloud URL - not voice.example.com."
          : "";
      setLastError({ message: msg + hint, kind: "network" });
    } finally {
      if (connectAbortRef.current === controller) {
        connectAbortRef.current = null;
      }
    }
  }

  async function handleDisconnect(): Promise<void> {
    disconnect();
  }

  const handleConnectRef = useRef(handleConnect);
  handleConnectRef.current = handleConnect;

  const onKerbalizerParamsChange = useCallback((next: Partial<KerbalizerParams>) => {
    setKerbalizerParams((p) => ({ ...p, ...next }));
    kerbalizerRef.current?.setParams(next);
  }, []);

  /**
   * Hot-toggle the Kerbalizer while connected. Builds (or tears down) the DSP wrapper,
   * then swaps the published mic source via `LocalAudioTrack.replaceTrack`  no rejoin,
   * no SDP renegotiation, no audible drop. When called while disconnected, it just
   * flips the flag so the next `handleConnect()` builds the right pipeline.
   */
  const toggleKerbalizerLive = useCallback(
    async (enabled: boolean): Promise<void> => {
      const vh = handleRef.current;
      // Not connected yet (or no publish cap)  flag flip is enough for next Join.
      if (!vh || !caps?.canPublish) {
        setUseKerbalizer(enabled);
        return;
      }
      if (kerbalizerSwapInFlightRef.current) return;
      kerbalizerSwapInFlightRef.current = true;
      try {
        if (enabled) {
          setUseKerbalizer(true);
          setKerbalizerParams((p) => ({ ...p, enabled: true }));
          await vh.setNoiseCancellation(false);
          disposeKerbalizerOnly();
          const prevStream = micStreamRef.current;
          const dspStream = await navigator.mediaDevices.getUserMedia({
            audio: publishMicConstraints(true),
            video: false
          });
          const dspRaw = dspStream.getAudioTracks()[0];
          if (!dspRaw) {
            dspStream.getTracks().forEach((t) => t.stop());
            setUseKerbalizer(false);
            return;
          }
          const kh = await createKerbalizerTrack(dspRaw, {
            initialParams: { ...kerbalizerParams, enabled: true }
          }).catch((e) => {
            dspStream.getTracks().forEach((t) => t.stop());
            throw e;
          });
          kerbalizerRef.current = kh;
          setDspMode(kh.mode);
          meterUnsubRef.current = kh.subscribeMeters(setKerbalizerMeters);
          const ok = await vh.setMicSource(kh.outputTrack);
          if (!ok) {
            disposeKerbalizerOnly();
            dspStream.getTracks().forEach((t) => t.stop());
            setUseKerbalizer(false);
            return;
          }
          prevStream?.getTracks().forEach((t) => t.stop());
          micStreamRef.current = dspStream;
        } else {
          const prevStream = micStreamRef.current;
          const plainStream = await navigator.mediaDevices.getUserMedia({
            audio: publishMicConstraints(false),
            video: false
          });
          const plainRaw = plainStream.getAudioTracks()[0];
          if (!plainRaw) {
            plainStream.getTracks().forEach((t) => t.stop());
            return;
          }
          const ok = await vh.setMicSource(plainRaw);
          if (!ok) {
            plainStream.getTracks().forEach((t) => t.stop());
            await vh.setNoiseCancellation(noiseCancellation);
            return;
          }
          disposeKerbalizerOnly();
          prevStream?.getTracks().forEach((t) => t.stop());
          micStreamRef.current = plainStream;
          await vh.setNoiseCancellation(noiseCancellation);
          setUseKerbalizer(false);
        }
        // The published MediaStreamTrack just changed; the local mic level meter was
        // tapping the old one (now silent). Re-tap the new one.
        startLocalMicMeter(vh.getLocalMicMediaStreamTrack());
      } catch (e) {
        console.warn("[voice] Kerbalizer hot-swap failed", e);
        // Last-ditch cleanup so we don't leak DSP if mid-build threw.
        if (enabled) {
          disposeKerbalizerOnly();
          setUseKerbalizer(false);
        }
      } finally {
        kerbalizerSwapInFlightRef.current = false;
      }
    },
    [caps?.canPublish, disposeKerbalizerOnly, kerbalizerParams, noiseCancellation, startLocalMicMeter]
  );

  const applyCombinedPttMic = useCallback((): void => {
    const h = handleRef.current;
    const { canPublish: cp } = pttVoicePrefsRef.current;
    if (!h || !cp) return;
    const want = pttGateMicOpen({
      pttMode: true,
      towerPhysicalHeld: towerPttPhysicalRef.current,
      bridgePttFromKsp: bridgePttFromKspRef.current,
      manualUnmuted: true
    });
    const muted = !want;
    setMicMuted(muted);
    micMutedRef.current = muted;
    void h.setMicEnabled(want);
  }, []);

  const connected = roomState === ConnectionState.Connected;
  const reconnecting =
    roomState === ConnectionState.Reconnecting || roomState === ConnectionState.SignalReconnecting;
  const isConnectingUi = connecting || roomState === ConnectionState.Connecting;
  const liveCaps = useLiveKitSessionCaps(sessionId, {
    pollIntervalMs: 10_000,
    enabled: isServerRadioRoom || canJoinTowerOpsVoice
  });

  const autoConnectForSessionRef = useRef<string | null>(null);
  const prevSessionRef = useRef(sessionId.trim());
  useEffect(() => {
    const id = sessionId.trim();
    const prev = prevSessionRef.current;
    if (prev === id) return;
    prevSessionRef.current = id;
    autoConnectForSessionRef.current = null;
    if (connecting || roomState !== null || handleRef.current) {
      disconnect();
    }
  }, [sessionId, connecting, roomState, disconnect]);

  useEffect(() => {
    if (!connected || !caps || liveCaps.state.kind !== "ok") return;
    if (
      caps.canPublish !== liveCaps.state.canPublish ||
      caps.canSubscribe !== liveCaps.state.canSubscribe ||
      caps.roomName !== liveCaps.state.roomName
    ) {
      autoConnectForSessionRef.current = null;
      disconnect();
    }
  }, [connected, caps, liveCaps.state, disconnect]);

  useEffect(() => {
    const id = sessionId.trim();
    if (!id) {
      autoConnectForSessionRef.current = null;
      return;
    }
    if (connected || connecting) return;
    if (autoConnectForSessionRef.current === id) return;
    autoConnectForSessionRef.current = id;
    void handleConnectRef.current();
  }, [sessionId, connected, connecting]);

  /* Mouse/touch PTT: hold the pill (or anywhere after pressing it) to transmit, release to mute.
     Pointer capture keeps the release event coming to us even if the cursor leaves the pill,
     so the mic can never be left hot when the user lifts off-target. */
  const pttPointerActiveRef = useRef(false);
  const onPttPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!connected || !caps?.canPublish) return;
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers reject capture on synthetic pointers; safe to ignore */
      }
      pttPointerActiveRef.current = true;
      towerPttPhysicalRef.current = true;
      setPttHeld(true);
      applyCombinedPttMic();
    },
    [connected, caps?.canPublish, applyCombinedPttMic]
  );
  const releasePttPointer = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pttPointerActiveRef.current) return;
      pttPointerActiveRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      towerPttPhysicalRef.current = false;
      setPttHeld(false);
      applyCombinedPttMic();
    },
    [applyCombinedPttMic]
  );

  const pttBarDownRef = useRef(onPttPointerDown);
  pttBarDownRef.current = onPttPointerDown;
  const pttBarUpRef = useRef(releasePttPointer);
  pttBarUpRef.current = releasePttPointer;

  /* PTT: while connected with publish, mic is muted unless T is held (or pointer PTT from Settings/top bar). */
  useEffect(() => {
    if (!connected || !caps?.canPublish) {
      pttPointerActiveRef.current = false;
      setPttHeld(false);
      return;
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (!isPttKey(e) || isTypingTarget(e.target) || e.repeat) return;
      e.preventDefault();
      towerPttPhysicalRef.current = true;
      setPttHeld(true);
      applyCombinedPttMic();
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (!isPttKey(e)) return;
      e.preventDefault();
      towerPttPhysicalRef.current = false;
      setPttHeld(false);
      applyCombinedPttMic();
    }
    function onBlur(): void {
      towerPttPhysicalRef.current = false;
      setPttHeld(false);
      applyCombinedPttMic();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [connected, caps?.canPublish, applyCombinedPttMic]);

  useEffect(() => {
    if (!connected || !caps?.canPublish) return;
    applyCombinedPttMic();
  }, [connected, caps?.canPublish, applyCombinedPttMic]);

  /* Live-toggle Krisp without reconnecting. Lazy-loads the WASM on first enable. */
  useEffect(() => {
    if (!connected || !caps?.canPublish) return;
    const h = handleRef.current;
    if (!h) return;
    if (useKerbalizer) {
      void h.setNoiseCancellation(false);
      return;
    }
    void h.setNoiseCancellation(noiseCancellation);
  }, [noiseCancellation, connected, caps?.canPublish, useKerbalizer]);

  useEffect(() => {
    const down = (e: React.PointerEvent<HTMLButtonElement>) => pttBarDownRef.current(e);
    const up = (e: React.PointerEvent<HTMLButtonElement>) => pttBarUpRef.current(e);
    registerVoiceTopBar({
      snapshot: {
        present: true,
        connected,
        connecting: isConnectingUi,
        reconnecting,
        canPublish: Boolean(caps?.canPublish),
        canSubscribe: Boolean(caps?.canSubscribe),
        pttEnabled: true,
        micHot: pttHeld && Boolean(caps?.canPublish)
      },
      ptt:
        caps?.canPublish && connected
          ? { onPointerDown: down, onPointerUp: up }
          : null
    });
    return () => {
      resetVoiceTopBar();
    };
  }, [connected, isConnectingUi, reconnecting, caps?.canPublish, caps?.canSubscribe, pttHeld, caps]);

  const showSubscribeBanner = caps && !caps.canPublish && caps.canSubscribe;
  const showTowerOpsWebHint =
    !connected && !caps && !isServerRadioRoom && !canJoinTowerOpsVoice;
  const blocked403 = lastError?.kind === "forbidden";
  const noTokenRoute = lastError?.kind === "no_token";
  const sessionNotFound = lastError?.kind === "not_found";

  const anyRemoteSpeaking = participants.some((p) => !p.isLocal && p.isSpeaking);
  const effectiveIncomingLevel = Math.max(incomingLevel, anyRemoteSpeaking ? 0.22 : 0);
  const meterPercent = Math.round(Math.min(1, effectiveIncomingLevel) * 100);
  const localMicPercent = Math.round(Math.min(1, localMicLevel) * 100);
  const transmitting = connected && caps?.canPublish && !micMuted;
  const radioChannelBusy = connected && (anyRemoteSpeaking || bridgePttActive || transmitting);
  const radioBlocked = transmitting && anyRemoteSpeaking;
  const txSource = !connected || !caps?.canPublish
    ? "idle"
    : bridgePttActive && pttHeld
      ? "KSP + Web PTT"
      : bridgePttActive
        ? "KSP PTT"
        : pttHeld
          ? "Web PTT"
          : "idle";
  const webTxActive = txSource === "Web PTT" || txSource === "KSP + Web PTT";
  const localMicDisplayPercent = webTxActive ? localMicPercent : 0;
  const talkingNow = participants.filter(
    (p) =>
      p.isSpeaking ||
      (bridgePttActive && !p.isLocal && p.identity === KSP_VOICE_BRIDGE_IDENTITY)
  );
  const talkingNowLabel =
    talkingNow.length > 0
      ? talkingNow
          .map((p) => {
            if (p.isLocal) return "You";
            if (p.identity === KSP_VOICE_BRIDGE_IDENTITY) {
              return p.displayName || "Pilot (in-game)";
            }
            return p.displayName || p.identity;
          })
          .join(", ")
      : bridgePttActive
        ? "Pilot (in-game)"
        : "Nobody";

  const mainCard = (
    <div className="card">
        <div className="card-head">
          <h2>Voice room</h2>
          {connected ? (
            <span className={`voice-tx-pill ${transmitting ? "live" : "idle"}`} aria-live="polite">
              <span className="voice-tx-dot" aria-hidden />{" "}
              {radioBlocked
                ? "BLOCKED - SAY AGAIN"
                : radioChannelBusy
                  ? `FREQ BUSY: ${talkingNowLabel}`
                  : "Frequency clear"}
            </span>
          ) : null}
        </div>

        <div className="voice-client-strip" aria-label="Voice connection">
          <div className="voice-status-row">
            <div
              className={
                "voice-status-pill " +
                (connected ? "connected" : isConnectingUi || reconnecting ? "connecting" : "disconnected")
              }
            >
              <span className="voice-status-dot" aria-hidden />
              {connected
                ? caps?.canSubscribe && !caps.canPublish
                  ? "Connected (receive-only)"
                  : "Connected"
                : isConnectingUi || reconnecting
                  ? reconnecting
                    ? "Reconnecting..."
                    : "Connecting..."
                  : "Disconnected"}
            </div>
            {caps?.roomName ? (
              <div className="voice-room-line">
                {caps.frequencyMhz ? (
                  <>
                    Frequency <code>{displayMhzFromCanonical(caps.frequencyMhz)} MHz</code>
                    {caps.sessionName ? <> - {caps.sessionName}</> : null}
                  </>
                ) : (
                  <>
                    Room <code>{caps.roomName}</code>
                  </>
                )}
              </div>
            ) : (
              <div className="voice-room-line">Join a frequency to see tower audio here.</div>
            )}
          </div>

          <div className="voice-meter-wrap">
            <span className="voice-meter-label">Web TX mic monitor ({localMicDisplayPercent}%)</span>
            <div className="voice-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={localMicDisplayPercent}>
              <div className="voice-meter-fill" style={{ width: `${localMicDisplayPercent}%` }} />
            </div>
          </div>

          <div className="voice-meter-wrap">
            <span className="voice-meter-label">Incoming</span>
            <div className="voice-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meterPercent}>
              <div className="voice-meter-fill" style={{ width: `${connected ? meterPercent : 0}%` }} />
            </div>
          </div>

          <div className="voice-controls-row">
            <span className="voice-mic-hint">
              {connected
                ? caps?.canPublish
                  ? `${radioBlocked ? "Blocked transmission. " : radioChannelBusy ? `Frequency busy: ${talkingNowLabel}. ` : "Frequency clear. "}Hold ${PTT_KEY_LABEL} (when not typing in a field) or use push-to-talk in Settings or the top bar.`
                  : "You can hear tower; this account cannot transmit."
                : isServerRadioRoom
                  ? "Tap Join voice to tune this channel. Publish depends on your account role."
                  : !canJoinTowerOpsVoice
                    ? "Tower ops voice in the browser is limited to the assigned controller. Use Hear tower audio on a lobby room card to listen, or use in-game voice with the local bridge."
                    : `Tap Join voice, then transmit with ${PTT_KEY_LABEL} or the Settings / top-bar push-to-talk control.`}
            </span>
          </div>

          <div className="row voice-options-row">
            <label
              className="voice-option-line"
              title={
                useKerbalizer
                  ? "Off while Kerbalizer is on — Krisp expects a raw speech path."
                  : noiseCancellationSupported
                    ? "LiveKit Krisp on your published mic (~5 MB first enable). Pauses automatically if Kerbalizer is on."
                    : "Krisp noise filter is not supported in this browser."
              }
            >
              <input
                type="checkbox"
                checked={noiseCancellation}
                disabled={
                  useKerbalizer ||
                  !noiseCancellationSupported ||
                  (connected && !caps?.canPublish)
                }
                onChange={(e) => setNoiseCancellation(e.target.checked)}
              />
              <span>
                <strong>Noise cancellation</strong>{" "}
                {connected && caps?.canPublish && noiseCancellation && !useKerbalizer ? (
                  <small style={{ color: noiseCancellationActive ? "var(--accent)" : "var(--muted)" }}>
                    ({noiseCancellationActive ? "active" : "loading..."})
                  </small>
                ) : connected && caps?.canPublish && noiseCancellation && useKerbalizer ? (
                  <small style={{ color: "var(--muted)" }}>(paused while Kerbalizer on)</small>
                ) : !noiseCancellationSupported ? (
                  <small style={{ color: "var(--muted)" }}>(unsupported)</small>
                ) : null}
              </span>
            </label>
          </div>

          {showTowerOpsWebHint ? (
            <div
              className="msg ok"
              style={{ marginTop: "0.5rem", borderLeft: "3px solid var(--accent)", background: "#0d1520" }}
            >
              <strong>Tower ops voice</strong> — only the assigned controller joins this channel from
              the web. Return to the lobby and use <strong>Hear tower audio</strong> on a room card to
              listen without spectating, or use the KSP voice bridge when you are the pilot.
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="voice-join-btn voice-join-toggle"
              onClick={() => {
                if (connected || reconnecting) void handleDisconnect();
                else void handleConnect();
              }}
              disabled={
                !(connected || reconnecting) &&
                (!sessionId.trim() ||
                  connecting ||
                  isConnectingUi ||
                  (!isServerRadioRoom && !canJoinTowerOpsVoice))
              }
              aria-pressed={connected || reconnecting}
              title={
                connected || reconnecting
                  ? "Disconnect from voice"
                  : !sessionId.trim()
                    ? "No active room"
                    : !isServerRadioRoom && !canJoinTowerOpsVoice
                      ? "Only the assigned controller can join tower ops voice from the browser"
                      : "Connect to this room’s voice"
              }
            >
              {connected || reconnecting
                ? "Leave voice"
                : connecting || isConnectingUi
                  ? "Joining..."
                  : "Join voice"}
            </button>
          </div>
        </div>

        {/* The manual "Session id" editor and "Reset to dev-shared" button used
         * to live here. Both are gone: the active room is now decided by the
         * server (`/v1/me/active-room`, polled by the App shell) and reflected
         * in the topbar pill, so giving the user a free-form text box that
         * could point voice at any session id was just a footgun. The /tower
         * route guard refuses to mount this page without a real room. */}

        <div style={{ marginTop: "1rem" }}>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}
            title="Radio-style processing on your published mic (high-pass, band-limit, saturation, formant). Optional chipmunk voice in controls below. Receive-only roles have no publish path. Disables browser capture AEC on this path — prefer headphones on speakers."
          >
            <input
              type="checkbox"
              checked={useKerbalizer}
              disabled={connecting || (connected && caps !== null && !caps.canPublish)}
              onChange={(e) => void toggleKerbalizerLive(e.target.checked)}
            />
            <span><strong>Kerbalizer</strong></span>
          </label>
        </div>

        {useKerbalizer ? (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
            {caps && !caps.canPublish ? (
              <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                Kerbalizer runs on the publish path only - subscribe-only sessions skip DSP.
              </p>
            ) : null}
            <KerbalizerControls
              params={kerbalizerParams}
              onParamsChange={onKerbalizerParamsChange}
              meters={kerbalizerMeters}
              mode={dspMode}
              disabled={connecting}
            />
          </div>
        ) : null}

        {showSubscribeBanner ? (
          <div
            className="msg ok"
            style={{ marginTop: "0.75rem", borderLeft: "3px solid var(--accent)", background: "#0d1520" }}
          >
            <strong>Subscribe-only mode</strong> - you can hear the room but cannot transmit. Join as pilot or assigned tower to publish.
          </div>
        ) : null}

        {permissionDenied ? (
          <div className="msg error" style={{ marginTop: "0.75rem" }}>
            <strong>{errorKindLabel("permission_denied")}</strong> - allow microphone in the browser site settings, then disconnect and connect again.
          </div>
        ) : null}

        {blocked403 ? (
          <div className="msg error" style={{ marginTop: "0.75rem" }}>
            <strong>Not authorized</strong> - this account cannot join this voice room (403). Check session role.
          </div>
        ) : null}

        {noTokenRoute ? (
          <div className="msg error" style={{ marginTop: "0.75rem" }}>
            Enter a session id before connecting.
          </div>
        ) : null}

        {sessionNotFound ? (
          <div className="msg error" style={{ marginTop: "0.75rem" }}>
            <strong>{errorKindLabel("not_found")}</strong> - the backend has no session with id{" "}
            <code>{sessionId}</code>. The session may have been closed or the backend restarted in
            in-memory mode. Go back to the Lobby and join (or create) a fresh tower room.
          </div>
        ) : null}

        {lastError && !blocked403 && !noTokenRoute && !sessionNotFound && lastError.kind !== "permission_denied" ? (
          <pre className="msg error" style={{ marginTop: "0.75rem" }}>
            [{errorKindLabel(lastError.kind)}] {formatApiError(lastError.status ?? 0, lastError.message, "livekit")}
          </pre>
        ) : null}

        <div
          ref={audioMountRef}
          aria-hidden
          style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
        />
      </div>
  );

  const extraCards =
    connected || reconnecting ? (
      <>
        <div className="card">
          <h2>HullCam</h2>
          <HullCamPanel sessionId={sessionId} compact />
        </div>
        <div className="card">
          <h2>Participants</h2>
          {participants.length === 0 ? (
            <p style={{ color: "var(--muted)", margin: 0 }}>No participant rows yet - connection may still be syncing.</p>
          ) : (
            <>
              {participants.filter((p) => !p.isLocal).length === 0 ? (
                <p style={{ color: "var(--muted)", margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
                  No <em>remote</em> LiveKit participants yet. Run the <strong>voice-bridge</strong> to see{" "}
                  <code>ksp_bridge</code> here.
                </p>
              ) : null}
              <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                {participants.map((p) => (
                  <li key={(p.isLocal ? "local:" : "remote:") + p.identity} style={{ marginBottom: "0.35rem" }}>
                    {p.isLocal ? <span style={{ color: "var(--muted)", marginRight: "0.35rem" }}>You</span> : null}
                    <strong>{p.displayName || p.identity}</strong>
                    {p.frequencyMhz ? (
                      <code style={{ marginLeft: "0.35rem", color: "var(--accent)", fontSize: "0.85rem" }}>
                        {displayMhzFromCanonical(p.frequencyMhz)} MHz
                      </code>
                    ) : null}
                    {p.displayName ? (
                      <code style={{ marginLeft: "0.35rem", color: "var(--muted)", fontSize: "0.85rem" }}>{p.identity}</code>
                    ) : null}
                    {p.isSpeaking ? (
                      <span style={{ marginLeft: "0.5rem", color: "var(--ok)", fontSize: "0.85rem" }}>speaking</span>
                    ) : (
                      <span style={{ marginLeft: "0.5rem", color: "var(--muted)", fontSize: "0.85rem" }}>idle</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </>
    ) : null;

  if (embedInWall) {
    return (
      <div className="tower-wall-embed-desk">
        {mainCard}
      </div>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Voice</h1>
          <p>LiveKit room for the active session. Connect, then transmit with push-to-talk only ({PTT_KEY_LABEL} or Settings).</p>
        </div>
      </header>
      {mainCard}
      {extraCards}
    </>
  );
}




