import {
  ConnectionState,
  createAudioAnalyser,
  isRemoteParticipant,
  LocalAudioTrack,
  type LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type TrackPublication
} from "livekit-client";
import { apiFetch } from "../api/client";
import { dispatchKspPttData } from "./kspPttDispatch";
import type { LiveKitTokenResponse, VoiceErrorKind, VoiceParticipantRow } from "./types";

export function mapHttpStatusToVoiceErrorKind(status: number): VoiceErrorKind {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 503) return "livekit_unavailable";
  return "unknown";
}

export type LiveKitRoomFlavor = "ops" | "booth" | "lobby_ops";

export type TokenRequestResult =
  | {
      ok: true;
      data: Required<Pick<LiveKitTokenResponse, "token" | "wsUrl" | "canPublish" | "canSubscribe">> & {
        roomName: string;
        sessionName?: string | null;
        frequencyMhz?: string | null;
        flavor: LiveKitRoomFlavor;
        /** Backend-reported booth kill-switch state. Only meaningful when `flavor === "booth"`. */
        boothMuted?: boolean;
      };
    }
  | { ok: false; message: string; status: number; kind: VoiceErrorKind; body?: unknown };

/**
 * Mint a LiveKit token for the given session. `flavor` selects which room to
 * join: `"ops"` (tower ops mix, default for back-compat), `"booth"` (spectator
 * commentary room — pilot is excluded), or `"lobby_ops"` (subscribe-only to
 * the ops mix from the lobby without joining the session roster). The backend
 * decides publish/subscribe per flavor, so callers shouldn't try to upgrade
 * either flag client-side.
 */
export async function requestLiveKitToken(
  sessionId: string,
  flavor: LiveKitRoomFlavor = "ops",
  signal?: AbortSignal
): Promise<TokenRequestResult> {
  const id = sessionId.trim();
  if (!id) {
    return { ok: false, message: "Session id is required", status: 0, kind: "no_token" };
  }
  const r = await apiFetch<LiveKitTokenResponse & { flavor?: string; boothMuted?: boolean }>(
    `/v1/session/${encodeURIComponent(id)}/livekit-token`,
    {
      method: "POST",
      body: JSON.stringify({ flavor }),
      signal
    }
  );
  if (!r.ok) {
    return {
      ok: false,
      message: r.message,
      status: r.status,
      kind: mapHttpStatusToVoiceErrorKind(r.status),
      body: r.body
    };
  }
  const d = r.data;
  const token = d.token;
  const wsUrl = d.wsUrl;
  if (typeof token !== "string" || !token) {
    return { ok: false, message: "Token missing in response", status: r.status, kind: "unknown" };
  }
  if (typeof wsUrl !== "string" || !wsUrl) {
    return { ok: false, message: "WebSocket URL missing in response", status: r.status, kind: "unknown" };
  }
  if (typeof d.canPublish !== "boolean" || typeof d.canSubscribe !== "boolean") {
    return { ok: false, message: "canPublish / canSubscribe missing in response", status: r.status, kind: "unknown" };
  }
  const roomName = typeof d.roomName === "string" ? d.roomName : "";
  const respFlavor: LiveKitRoomFlavor =
    d.flavor === "booth" ? "booth" : d.flavor === "lobby_ops" ? "lobby_ops" : "ops";
  return {
    ok: true,
    data: {
      token,
      wsUrl,
      canPublish: d.canPublish,
      canSubscribe: d.canSubscribe,
      roomName,
      ...(typeof d.sessionName === "string" ? { sessionName: d.sessionName } : {}),
      ...(typeof d.frequencyMhz === "string" ? { frequencyMhz: d.frequencyMhz } : {}),
      flavor: respFlavor,
      ...(typeof d.boothMuted === "boolean" ? { boothMuted: d.boothMuted } : {})
    }
  };
}

function parseParticipantMetadata(raw: string | undefined): Pick<VoiceParticipantRow, "frequencyMhz" | "roomName"> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { frequencyMhz?: unknown; roomName?: unknown };
    return {
      ...(typeof parsed.frequencyMhz === "string" ? { frequencyMhz: parsed.frequencyMhz } : {}),
      ...(typeof parsed.roomName === "string" ? { roomName: parsed.roomName } : {})
    };
  } catch {
    return {};
  }
}

function buildParticipantRows(room: Room, clientSpeakingIds: ReadonlySet<string>): VoiceParticipantRow[] {
  const active = new Set(room.activeSpeakers.map((p) => p.identity));
  const localIdentity = room.localParticipant.identity || "you";
  const localName = room.localParticipant.name?.trim();
  const localMeta = parseParticipantMetadata(room.localParticipant.metadata);
  const localIsSpeaking = Boolean(
    (room.localParticipant as unknown as { isSpeaking?: boolean }).isSpeaking || active.has(localIdentity)
  );

  const remoteRows = Array.from(room.remoteParticipants.values()).map((p) => {
    const dn = p.name?.trim();
    const meta = parseParticipantMetadata(p.metadata);
    const clientAudible = clientSpeakingIds.has(p.identity);
    return {
      identity: p.identity,
      displayName: dn || undefined,
      ...meta,
      isSpeaking: p.isSpeaking || active.has(p.identity) || clientAudible,
      isLocal: false
    };
  });

  return [
    {
      identity: localIdentity,
      displayName: localName || undefined,
      ...localMeta,
      isSpeaking: localIsSpeaking,
      isLocal: true
    },
    ...remoteRows
  ];
}

/** LiveKit identities for the Node KSP voice-bridge (same default as backend LIVEKIT_BRIDGE_IDENTITIES). */
export const KSP_VOICE_BRIDGE_IDENTITY = "ksp_bridge";
export const VOICE_BRIDGE_PLAYBACK_SKIP_DEFAULTS = [KSP_VOICE_BRIDGE_IDENTITY];

export type ConnectVoiceRoomOptions = {
  wsUrl: string;
  token: string;
  canPublish: boolean;
  /** Remote audio elements are appended here (hidden container). */
  audioContainer: HTMLElement;
  onConnectionState: (state: ConnectionState) => void;
  onParticipants: (rows: VoiceParticipantRow[]) => void;
  onError: (message: string, kind: VoiceErrorKind) => void;
  /**
   * When set (e.g. Kerbalizer send-path DSP), published instead of `setMicrophoneEnabled`.
   * Caller owns capture lifecycle (e.g. stops raw `getUserMedia` tracks on disconnect).
   */
  customMicTrack?: MediaStreamTrack;
  /**
   * Do not play remote audio from these participant identities (still listed in the room).
   * Legacy guard from when the voice-bridge also published the Windows mic; the bridge now only sends
   * a PTT data packet, so this defaults to a no-op set. Kept for callers that want to mute specific
   * identities (e.g. tower observers).
   */
  skipRemotePlaybackForIdentities?: string[];
  /**
   * Called when the KSP voice-bridge sends a `{type:"ksp_ptt", on:bool}` data packet.
   * Use this to drive the tower's own mic mute state from the in-game push-to-talk button.
   */
  onBridgePtt?: (on: boolean, fromIdentity: string) => void;
  /**
   * Apply LiveKit's Krisp ML noise cancellation as a TrackProcessor on the published mic track.
   * Lazy-imports `@livekit/krisp-noise-filter` (≈5 MB WASM) only when first enabled.
   * No-op on browsers that don't support audio worklets / WASM SIMD.
   * Default: false (callers opt in).
   */
  noiseCancellation?: boolean;
  /**
   * Notified when the Krisp processor's actual enabled state changes (e.g. failed to load → false).
   * Lets the UI keep its checkbox in sync with reality.
   */
  onNoiseCancellationStateChange?: (enabled: boolean, supported: boolean) => void;
};

type IncomingAnalyser = {
  calculateVolume: () => number;
  cleanup: () => Promise<void>;
  /** Remote LiveKit identity for this subscribed audio track. */
  identity: string;
  /** Resume Web Audio if the browser suspended it (common for listen-only / no GUM). */
  preRead?: () => void;
};

export type VoiceRoomHandle = {
  room: Room;
  setMicEnabled: (enabled: boolean) => Promise<void>;
  getLocalMicMediaStreamTrack: () => MediaStreamTrack | undefined;
  disconnect: () => void;
  /** Peak-ish level 0–1 from remote participants’ audio (RAF-driven; unsubscribe stops updates). */
  subscribeIncomingLevel(cb: (level01: number) => void): () => void;
  /**
   * Toggle Krisp noise cancellation on the live published mic track without reconnecting.
   * Resolves to the actual enabled state (false if the package failed to load or the browser is
   * unsupported). Safe to call before publish — the request is queued and applied when the mic
   * track becomes available.
   */
  setNoiseCancellation(enabled: boolean): Promise<boolean>;
  /**
   * Hot-swap the underlying MediaStreamTrack of the published mic publication. Uses LiveKit's
   * `LocalAudioTrack.replaceTrack` so the RTCRtpSender keeps the same SSRC / PeerConnection —
   * no SDP renegotiation, no remote re-subscribe, no audible drop. Used to enable/disable the
   * Kerbalizer (or any send-path DSP) while connected. Caller owns the lifecycle of `track`.
   * Returns true on success, false if the participant cannot publish or there is no live audio
   * publication to swap.
   */
  setMicSource(track: MediaStreamTrack): Promise<boolean>;
};

const KRISP_PROCESSOR_NAME = "livekit-noise-filter";

type KrispProcessorHandle = {
  name: string;
  setEnabled(enabled: boolean): Promise<void>;
};

type KrispLoaded = {
  factory: () => KrispProcessorHandle;
  supported: boolean;
};

let krispLoadPromise: Promise<KrispLoaded | null> | null = null;

async function loadKrisp(): Promise<KrispLoaded | null> {
  if (krispLoadPromise) {
    return krispLoadPromise;
  }
  krispLoadPromise = (async () => {
    try {
      const mod = await import("@livekit/krisp-noise-filter");
      const supported = mod.isKrispNoiseFilterSupported();
      if (!supported) {
        console.warn("[voice] Krisp noise filter unsupported in this browser");
        return { factory: () => mod.KrispNoiseFilter() as KrispProcessorHandle, supported: false };
      }
      return { factory: () => mod.KrispNoiseFilter() as KrispProcessorHandle, supported: true };
    } catch (e) {
      console.warn("[voice] failed to load @livekit/krisp-noise-filter", e);
      return null;
    }
  })();
  return krispLoadPromise;
}

function getLocalAudioTrackFromPublication(pub: LocalTrackPublication | undefined): LocalAudioTrack | null {
  const t = pub?.track;
  if (t instanceof LocalAudioTrack) return t;
  return null;
}

function resolveSkipPlaybackIdentities(options: ConnectVoiceRoomOptions): Set<string> {
  if (options.skipRemotePlaybackForIdentities !== undefined) {
    return new Set(options.skipRemotePlaybackForIdentities);
  }
  // Bridge no longer publishes audio; nothing to suppress by default. Kept for explicit callers.
  return new Set();
}

/**
 * RMS from float time-domain samples (0..1-ish). LiveKit's default `calculateVolume` uses
 * `getByteFrequencyData`, which often reads ~0 for Opus speech while the graph is suspended
 * or when energy sits outside the analyser dB window — audio still plays on `<audio>`.
 */
function analyserRmsFromFloatTimeDomain(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  // Booth / receive-only often runs quieter in the float buffer than ops+mic paths.
  return Math.min(1, rms * 6);
}

export async function connectVoiceRoom(options: ConnectVoiceRoomOptions): Promise<VoiceRoomHandle> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true
  });

  const skipPlaybackFor = resolveSkipPlaybackIdentities(options);
  const incomingAnalysers = new Map<string, IncomingAnalyser>();
  /** RMS-derived “speaking” when SFU active-speaker / audioLevel lags or stays at 0. */
  let clientSpeakingIds = new Set<string>();
  let clientSpeakingSerialized = "";

  const updateParticipants = (): void => {
    options.onParticipants(buildParticipantRows(room, clientSpeakingIds));
  };

  const onConn = (): void => {
    options.onConnectionState(room.state);
  };

  room.on(RoomEvent.ConnectionStateChanged, onConn);
  room.on(RoomEvent.Disconnected, onConn);

  const unlockIncomingPlayback = async (): Promise<void> => {
    try {
      await room.startAudio();
    } catch {
      /* NotAllowedError until user gesture — see LiveKit Room.startAudio docs */
    }
  };

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    if (!isRemoteParticipant(participant)) return;
    if (skipPlaybackFor.has(participant.identity)) {
      updateParticipants();
      return;
    }
    const mapKey = publication.trackSid || track.sid;
    if (!mapKey) {
      updateParticipants();
      return;
    }
    const el = track.attach();
    if (el instanceof HTMLAudioElement) {
      el.playsInline = true;
      el.setAttribute("playsinline", "");
    }
    options.audioContainer.appendChild(el);
    void el.play().catch(() => {
      /* autoplay policy — user gesture may be required */
    });
    void unlockIncomingPlayback();
    void (async (): Promise<void> => {
      try {
        const ar = createAudioAnalyser(track as RemoteAudioTrack, {
          fftSize: 1024,
          smoothingTimeConstant: 0.72,
          // LiveKit’s defaults (-100..-80 dB) squash normal speech in getByteFrequencyData.
          minDecibels: -100,
          maxDecibels: -32,
          // Separate graph from `<audio>` + avoids oddities when the element is muted for WebAudio mix.
          cloneTrack: true
        }) as {
          calculateVolume: () => number;
          cleanup: () => Promise<void>;
          analyser?: AnalyserNode;
        };
        const analyser = ar.analyser;
        const ctx = analyser?.context;
        if (ctx?.state === "suspended") {
          await ctx.resume().catch(() => {});
        }
        const freqVolume = (): number => ar.calculateVolume();
        const calculateVolume =
          analyser !== undefined
            ? (): number => Math.max(freqVolume(), analyserRmsFromFloatTimeDomain(analyser))
            : freqVolume;
        const preRead =
          analyser !== undefined
            ? (): void => {
                const c = analyser.context;
                if (c.state === "suspended") {
                  void c.resume().catch(() => {});
                }
              }
            : undefined;
        incomingAnalysers.set(mapKey, {
          calculateVolume,
          cleanup: ar.cleanup,
          identity: participant.identity,
          preRead
        });
      } catch (e) {
        console.warn("[voice] incoming analyser setup failed", e);
      }
      updateParticipants();
    })();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication: TrackPublication) => {
    const mapKey = publication.trackSid || track.sid;
    if (!mapKey) {
      track.detach();
      updateParticipants();
      return;
    }
    const a = incomingAnalysers.get(mapKey);
    if (a) {
      void a.cleanup();
      incomingAnalysers.delete(mapKey);
    }
    track.detach();
    updateParticipants();
  });

  room.on(RoomEvent.ParticipantConnected, (_p: RemoteParticipant) => {
    updateParticipants();
  });
  room.on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => {
    updateParticipants();
  });
  room.on(RoomEvent.ActiveSpeakersChanged, () => {
    updateParticipants();
  });

  if (options.onBridgePtt) {
    const cb = options.onBridgePtt;
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant) => {
      dispatchKspPttData(payload, participant, cb);
    });
  }

  try {
    await room.connect(options.wsUrl, options.token, { autoSubscribe: true });
  } catch (e) {
    room.removeAllListeners();
    await room.disconnect();
    const msg = e instanceof Error ? e.message : String(e);
    options.onError(msg, "network");
    throw e;
  }

  await unlockIncomingPlayback();

  let micPublication: LocalTrackPublication | undefined;

  if (options.canPublish) {
    try {
      if (options.customMicTrack) {
        micPublication = await room.localParticipant.publishTrack(options.customMicTrack);
      } else {
        micPublication = (await room.localParticipant.setMicrophoneEnabled(true)) ?? undefined;
      }
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        options.onError("Microphone permission denied", "permission_denied");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        options.onError(msg, "unknown");
      }
    }
  }

  let krispProcessor: KrispProcessorHandle | null = null;
  let krispDesired = options.noiseCancellation === true;
  let krispActualEnabled = false;
  let krispApplyingPromise: Promise<boolean> | null = null;
  const onKrispState = options.onNoiseCancellationStateChange;

  async function applyKrispDesired(): Promise<boolean> {
    if (krispApplyingPromise) {
      return krispApplyingPromise;
    }
    const job = (async (): Promise<boolean> => {
      if (!options.canPublish) {
        krispActualEnabled = false;
        onKrispState?.(false, false);
        return false;
      }
      const audioTrack = getLocalAudioTrackFromPublication(micPublication);
      if (!audioTrack) {
        return krispActualEnabled;
      }

      if (!krispDesired) {
        if (krispProcessor && krispActualEnabled) {
          try {
            await krispProcessor.setEnabled(false);
          } catch (e) {
            console.warn("[voice] krisp disable failed", e);
          }
        }
        krispActualEnabled = false;
        onKrispState?.(false, true);
        return false;
      }

      const loaded = await loadKrisp();
      if (!loaded) {
        krispActualEnabled = false;
        onKrispState?.(false, false);
        return false;
      }
      if (!loaded.supported) {
        krispActualEnabled = false;
        onKrispState?.(false, false);
        return false;
      }

      if (!krispProcessor) {
        krispProcessor = loaded.factory();
      }

      const existing = audioTrack.getProcessor() as { name?: string } | undefined;
      if (!existing || existing.name !== KRISP_PROCESSOR_NAME) {
        try {
          await audioTrack.setProcessor(krispProcessor as unknown as Parameters<LocalAudioTrack["setProcessor"]>[0]);
        } catch (e) {
          console.warn("[voice] krisp setProcessor failed", e);
          krispActualEnabled = false;
          onKrispState?.(false, true);
          return false;
        }
      }

      try {
        await krispProcessor.setEnabled(true);
        krispActualEnabled = true;
        onKrispState?.(true, true);
        return true;
      } catch (e) {
        console.warn("[voice] krisp enable failed", e);
        krispActualEnabled = false;
        onKrispState?.(false, true);
        return false;
      }
    })();
    krispApplyingPromise = job;
    try {
      return await job;
    } finally {
      krispApplyingPromise = null;
    }
  }

  if (options.canPublish && krispDesired) {
    void applyKrispDesired();
  }

  updateParticipants();

  const incomingLevelSubs = new Set<(level01: number) => void>();
  let meterRafId = 0;

  const runIncomingMeterFrame = (): void => {
    let max = 0;
    for (const p of room.remoteParticipants.values()) {
      if (skipPlaybackFor.has(p.identity)) {
        continue;
      }
      const level = p.audioLevel ?? 0;
      const speakingFloor = p.isSpeaking ? 0.25 : 0;
      max = Math.max(max, level, speakingFloor);
    }

    let analyserMax = 0;
    const nextClientSpeaking = new Set<string>();
    const RMS_SPEAK = 0.008;
    for (const { calculateVolume, identity, preRead } of incomingAnalysers.values()) {
      preRead?.();
      const v = calculateVolume();
      analyserMax = Math.max(analyserMax, v);
      if (v > RMS_SPEAK) {
        nextClientSpeaking.add(identity);
      }
    }
    const serialized = [...nextClientSpeaking].sort().join("\0");
    if (serialized !== clientSpeakingSerialized) {
      clientSpeakingSerialized = serialized;
      clientSpeakingIds = nextClientSpeaking;
      updateParticipants();
    }

    max = Math.max(max, analyserMax);
    const boosted = Math.min(1, max * 2.35);
    for (const cb of incomingLevelSubs) {
      cb(boosted);
    }
    meterRafId = requestAnimationFrame(runIncomingMeterFrame);
  };

  meterRafId = requestAnimationFrame(runIncomingMeterFrame);

  return {
    room,
    async setMicEnabled(enabled: boolean): Promise<void> {
      if (!options.canPublish) return;
      if (micPublication) {
        if (enabled) {
          await micPublication.unmute();
        } else {
          await micPublication.mute();
        }
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    getLocalMicMediaStreamTrack(): MediaStreamTrack | undefined {
      const track = micPublication?.track as { mediaStreamTrack?: MediaStreamTrack } | undefined;
      if (track?.mediaStreamTrack) {
        return track.mediaStreamTrack;
      }
      const lp = room.localParticipant as unknown as {
        getTrackPublication?: (
          source: Track.Source
        ) => { track?: { mediaStreamTrack?: MediaStreamTrack } } | undefined;
      };
      const micPub = lp.getTrackPublication?.(Track.Source.Microphone);
      if (micPub?.track?.mediaStreamTrack) {
        return micPub.track.mediaStreamTrack;
      }
      return options.customMicTrack;
    },
    subscribeIncomingLevel(cb: (level01: number) => void): () => void {
      incomingLevelSubs.add(cb);
      return (): void => {
        incomingLevelSubs.delete(cb);
      };
    },
    async setNoiseCancellation(enabled: boolean): Promise<boolean> {
      krispDesired = enabled;
      return applyKrispDesired();
    },
    async setMicSource(track: MediaStreamTrack): Promise<boolean> {
      if (!options.canPublish) return false;
      const lat = getLocalAudioTrackFromPublication(micPublication);
      if (!lat) return false;
      try {
        // userProvidedTrack=true: caller (VoiceDesk) owns capture lifecycle, including the
        // Kerbalizer's MediaStreamDestination output and the raw getUserMedia stream. LiveKit
        // must not stop them when the publication is later torn down.
        await (lat as unknown as {
          replaceTrack: (t: MediaStreamTrack, userProvidedTrack?: boolean) => Promise<void>;
        }).replaceTrack(track, true);
      } catch (e) {
        console.warn("[voice] setMicSource: replaceTrack failed", e);
        return false;
      }
      // replaceTrack rebinds any TrackProcessor (e.g. Krisp) onto the new MediaStreamTrack.
      // Re-apply the desired Krisp state to be safe — the call is idempotent and cheap when
      // the processor is already in the right state.
      if (krispDesired) {
        void applyKrispDesired();
      }
      return true;
    },
    disconnect(): void {
      cancelAnimationFrame(meterRafId);
      meterRafId = 0;
      incomingLevelSubs.clear();
      for (const a of incomingAnalysers.values()) {
        void a.cleanup();
      }
      incomingAnalysers.clear();
      options.audioContainer.replaceChildren();
      room.removeAllListeners();
      void room.disconnect();
    }
  };
}
