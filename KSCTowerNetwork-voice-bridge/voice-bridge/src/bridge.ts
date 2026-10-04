/**
 * Voice bridge for KSP: LiveKit room -> TCP PCM downlink, plus a tiny TCP control uplink for PTT.
 *
 * Downlink: TOWER_PCM s16le 48000 mono on PCM_PORT (default 47372).
 * Control:  newline commands on CTL_PORT (default 47373): MIC_ON, MIC_OFF, PING,
 *           SESSION:<id> (re-join LiveKit on a new session - used when the player
 *           manually tunes the in-game radio so the dev-mode bridge, which is
 *           launched once with a fixed SESSION_ID env, can follow tunes too).
 *
 * The bridge no longer captures any audio itself. PTT in KSP forwards over LiveKit's data channel
 * as a small JSON packet ({type:"ksp_ptt", on:bool}); the tower web tab listens and toggles its
 * own LocalParticipant mic. This avoids loading native PortAudio bindings (and their bundled
 * segfault-handler) into the same process as @livekit/rtc-node, which used to crash the bridge
 * the instant MIC_ON ran.
 *
 * Lifecycle: the bridge listens on PCM/CTL ports immediately, but ONLY joins the LiveKit room
 * while at least one KSP TCP connection is open. When the player quits KSP the OS closes both
 * sockets, and after KSP_IDLE_GRACE_MS of silence the bridge gracefully leaves the room - so
 * `ksp_bridge` stops appearing in admin / Voice-desk participant lists the moment KSP exits.
 * If KSP relaunches and reconnects, the bridge transparently re-joins with a fresh token.
 *
 * Env: TOWER_API_BASE, SESSION_ID, PCM_HOST, PCM_PORT, CTL_HOST, CTL_PORT,
 *      KSP_IDLE_GRACE_MS, KSP_WATCHDOG, KSP_PROCESS_NAME, KSP_WATCH_INTERVAL_MS,
 *      KSP_WATCH_MISSES_BEFORE_EXIT, SESSION_REJOIN_DELAY_MS (leave->join gap after
 *      a tune or "Participant already exists" cleanup; default 450).
 */
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import {
  AudioFrame,
  AudioMixer,
  AudioStream,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  dispose,
  type AudioFrame as AudioFrameT
} from "@livekit/rtc-node";
import {
  buildLiveKitTokenRequestUrl,
  parseSessionTuneCommand,
  readLiveKitTokenFromJsonBody
} from "./bridgeProtocol.js";
import { isLivekitTokenSessionNotFoundError, isParticipantAlreadyExistsJoinError } from "./livekitTokenErrors.js";

const execFileAsync = promisify(execFile);

const API_BASE = process.env.TOWER_API_BASE ?? "http://127.0.0.1:48787/v1";
// `currentSessionId` is mutable: env-default at boot, swapped at runtime by the
// `SESSION:<id>` control command. fetchLiveKitToken() reads it on every fetch
// so tune-driven re-joins always pull a token for the right room.
let currentSessionId = process.env.SESSION_ID ?? "ksc-radio-twr";
const PCM_HOST = process.env.PCM_HOST ?? "127.0.0.1";
const PCM_PORT = Number(process.env.PCM_PORT ?? "47372");
const CTL_HOST = process.env.CTL_HOST ?? "127.0.0.1";
const CTL_PORT = Number(process.env.CTL_PORT ?? "47373");
const SAMPLE_RATE = 48000;
const DEV_ID_HEADER = process.env.DEV_VOICE_IDENTITY_HEADER ?? "x-ksc-voice-identity";
const BRIDGE_IDENTITY = process.env.BRIDGE_IDENTITY ?? "ksp_bridge";
const CHANNELS = 1;
/**
 * How long after the LAST KSP TCP socket closes we wait before leaving the
 * LiveKit room. A short grace covers KSP scene transitions / brief pauses
 * (KSP keeps the connection alive across them, but better safe). 15s feels
 * snappy enough that "quit game -> disappear from participants" is obvious.
 */
const KSP_IDLE_GRACE_MS = Math.max(
  1000,
  Number(process.env.KSP_IDLE_GRACE_MS ?? "15000") || 15_000
);
const KSP_WATCHDOG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.KSP_WATCHDOG ?? "");
const KSP_PROCESS_NAME = process.env.KSP_PROCESS_NAME ?? "KSP_x64.exe";
const KSP_WATCH_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.KSP_WATCH_INTERVAL_MS ?? "5000") || 5000
);
const KSP_WATCH_MISSES_BEFORE_EXIT = Math.max(
  1,
  Number(process.env.KSP_WATCH_MISSES_BEFORE_EXIT ?? "3") || 3
);
/** After we leave LiveKit (tune / session swap), wait before re-join so the SFU drops the old `ksp_bridge` participant - instant re-connect often throws "Participant already exists" and breaks audio both ways. */
const SESSION_REJOIN_DELAY_MS = Math.max(
  0,
  Number(process.env.SESSION_REJOIN_DELAY_MS ?? "450") || 450
);
const LIVEKIT_TOKEN_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.LIVEKIT_TOKEN_FETCH_TIMEOUT_MS ?? "8000") || 8000
);
const CTL_MAX_BUFFER_BYTES = Math.max(
  1024,
  Number(process.env.CTL_MAX_BUFFER_BYTES ?? "8192") || 8192
);

async function isKspRunning(): Promise<boolean> {
  if (process.platform !== "win32") {
    return true;
  }

  try {
    const { stdout } = await execFileAsync("tasklist", [
      "/FI",
      `IMAGENAME eq ${KSP_PROCESS_NAME}`,
      "/FO",
      "CSV",
      "/NH"
    ]);
    const lower = stdout.toLowerCase();
    return lower.includes(`"${KSP_PROCESS_NAME.toLowerCase()}"`);
  } catch (e) {
    // Fail-open: if tasklist fails, keep bridge alive.
    console.warn("[voice-bridge] watchdog check failed; keeping bridge alive.", e);
    return true;
  }
}

function streamFromAudioStream(stream: AudioStream): AsyncIterable<AudioFrameT> {
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader();
      return {
        async next(): Promise<IteratorResult<AudioFrameT>> {
          const { done, value } = await reader.read();
          if (done) return { done: true, value: undefined };
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<AudioFrameT>> {
          await reader.cancel();
          return { done: true, value: undefined };
        }
      };
    }
  };
}

async function fetchLiveKitToken(): Promise<{ token: string; wsUrl: string }> {
  const url = buildLiveKitTokenRequestUrl(API_BASE, currentSessionId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVEKIT_TOKEN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEV_ID_HEADER]: BRIDGE_IDENTITY },
      body: "{}",
      signal: controller.signal
    });
    const j = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`livekit-token HTTP ${res.status}: ${JSON.stringify(j)}`);
    }
    return readLiveKitTokenFromJsonBody(j);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`livekit-token request timed out after ${LIVEKIT_TOKEN_FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveKitTokenWithRetry(maxAttempts = 40, delayMs = 1000): Promise<{ token: string; wsUrl: string }> {
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fetchLiveKitToken();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const quiet404 = isLivekitTokenSessionNotFoundError(msg);
      if (!quiet404 || i === 1 || i === maxAttempts || i % 10 === 0) {
        console.warn(`[voice-bridge] token fetch attempt ${i}/${maxAttempts} failed: ${msg}`);
      }
      if (i < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function broadcastPcm(sockets: Set<net.Socket>, buf: Buffer): void {
  for (const s of sockets) {
    if (s.writableEnded) continue;
    try {
      s.write(buf);
    } catch (e) {
      sockets.delete(s);
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      console.warn("[voice-bridge] dropped broken PCM socket", e);
    }
  }
}

function safeSocketWrite(socket: net.Socket, line: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(line);
  } catch {
    socket.destroy();
  }
}

async function main(): Promise<void> {
  const pcmSockets = new Set<net.Socket>();
  const ctlSockets = new Set<net.Socket>();

  let shuttingDown = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let idleLeaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** True iff we are currently joined to LiveKit (i.e. `ksp_bridge` is in the room). */
  let roomJoined = false;
  /** True while a join attempt is in flight, so concurrent connection events don't double-join. */
  let joinInProgress = false;
  /**
   * Set when WE deliberately left the room (KSP went away or shutdown).
   * The RoomEvent.Disconnected handler checks this to suppress its
   * auto-reconnect - otherwise leaving would immediately bounce us back in.
   */
  let intentionalDisconnect = false;
  let reconnectInProgress = false;
  let reconnectAttempts = 0;
  let connectionEpoch = 0;
  /** Half-duplex guard: while any active KSP CTL socket is transmitting, suppress downlink PCM (no sidetone). */
  const kspTxSockets = new Set<net.Socket>();

  const room = new Room();
  const MIXER_BLOCKSIZE = Math.floor(SAMPLE_RATE / 50);
  const streamRefs = new Map<string, AsyncIterable<AudioFrameT>>();

  function createKeepaliveSilenceStream(): AsyncIterable<AudioFrameT> {
    // Keepalive: AudioMixer auto-flips into `ending` mode the moment its stream
    // count drops to 0 after any stream exhausts. Once that flag is set, every
    // future addStream() throws "Cannot add stream after mixer has been closed"
    // and the bridge needs a restart. A silent stream that never returns done
    // keeps `streams.size >= 1` forever, defusing the auto-end.
    const keepaliveFrameMs = Math.round((MIXER_BLOCKSIZE / SAMPLE_RATE) * 1000);
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AudioFrameT>> {
            await new Promise((resolve) => setTimeout(resolve, keepaliveFrameMs));
            const silence = new Int16Array(MIXER_BLOCKSIZE * CHANNELS);
            const frame = new AudioFrame(silence, SAMPLE_RATE, CHANNELS, MIXER_BLOCKSIZE) as AudioFrameT;
            return { done: false, value: frame };
          },
          async return(): Promise<IteratorResult<AudioFrameT>> {
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  function createMixer(): AudioMixer {
    const next = new AudioMixer(SAMPLE_RATE, CHANNELS, {
      blocksize: MIXER_BLOCKSIZE,
      streamTimeoutMs: 120,
      capacity: 50
    });
    next.addStream(createKeepaliveSilenceStream());
    return next;
  }

  let mixer = createMixer();

  function clearRemoteStreams(): void {
    for (const it of streamRefs.values()) {
      try {
        mixer.removeStream(it);
      } catch {
        /* mixer may already be closed; the map clear below is authoritative */
      }
    }
    streamRefs.clear();
  }

  room.on(RoomEvent.TrackSubscribed, (track, publication) => {
    if (!(track instanceof RemoteAudioTrack)) return;
    const sid = publication.sid ?? track.sid ?? "";
    if (!sid) return;
    const audioStream = new AudioStream(track, SAMPLE_RATE, CHANNELS);
    const iterable = streamFromAudioStream(audioStream);
    try {
      mixer.addStream(iterable);
    } catch (e) {
      // Keepalive should make this unreachable, but if the mixer ever ends we
      // must NOT silently drop the track - log loudly so we notice instead of
      // serving dead air until someone restarts the bridge.
      console.error(`[voice-bridge] mixer.addStream rejected ${sid}; remote audio will be lost until bridge restart`, e);
      return;
    }
    streamRefs.set(sid, iterable);
    console.log(`[voice-bridge] subscribed remote audio ${sid}`);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
    const sid = publication.sid ?? track.sid ?? "";
    if (!sid) return;
    const it = streamRefs.get(sid);
    if (it) {
      mixer.removeStream(it);
      streamRefs.delete(sid);
    }
    console.log(`[voice-bridge] unsubscribed remote audio ${sid}`);
  });

  const pumpMixer = (async () => {
    let restartCount = 0;
    while (!shuttingDown) {
      try {
        for await (const frame of mixer) {
          if (kspTxSockets.size > 0) {
            continue;
          }
          // Suppress pure-keepalive output: when no real remote audio is
          // subscribed, mixed output is just our silence stream. Skip writing
          // it so KSP sees the same idle behavior it had before keepalive.
          if (streamRefs.size === 0) {
            continue;
          }
          const data = frame.data;
          const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          broadcastPcm(pcmSockets, buf);
        }
        if (!shuttingDown) {
          console.warn("[voice-bridge] mixer pump ended unexpectedly; rebuilding mixer");
        }
      } catch (e) {
        if (!shuttingDown) {
          console.error("[voice-bridge] mixer pump error; rebuilding mixer", e);
        }
      }
      if (shuttingDown) {
        return;
      }
      restartCount += 1;
      clearRemoteStreams();
      try {
        await mixer.aclose();
      } catch {
        /* already closed */
      }
      mixer = createMixer();
      console.warn(`[voice-bridge] mixer rebuilt (${restartCount})`);
    }
  })();

  async function connectLiveKit(wsUrl: string, token: string): Promise<boolean> {
    const epoch = connectionEpoch;
    intentionalDisconnect = false;
    await room.connect(wsUrl, token);
    if (epoch !== connectionEpoch || shuttingDown || !hasKspConnections()) {
      console.warn("[voice-bridge] LiveKit connect completed after state changed; disconnecting stale room");
      intentionalDisconnect = true;
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
      roomJoined = false;
      return false;
    }
    roomJoined = true;
    reconnectAttempts = 0;
    return true;
  }

  function scheduleJoinRetry(reason: string): void {
    if (shuttingDown || roomJoined || !hasKspConnections()) return;
    console.warn(`[voice-bridge] scheduling LiveKit join retry (${reason})`);
    setTimeout(() => {
      if (!shuttingDown && !roomJoined && hasKspConnections()) {
        void reconnectRoom();
      }
    }, Math.max(SESSION_REJOIN_DELAY_MS, 250));
  }

  /**
   * Join LiveKit if (and only if) KSP is currently connected and we are not already in.
   * Idempotent: safe to call from every "KSP connected" event.
   */
  async function joinRoomIfNeeded(): Promise<void> {
    if (shuttingDown || roomJoined || joinInProgress) return;
    if (!hasKspConnections()) return;
    joinInProgress = true;
    try {
      const tryConnect = async (): Promise<void> => {
        const sessionAtStart = currentSessionId;
        const fresh = await fetchLiveKitTokenWithRetry();
        // KSP could have quit while we were waiting on the backend; re-check.
        if (!hasKspConnections() || shuttingDown || sessionAtStart !== currentSessionId) {
          return;
        }
        // Reconnect backoff may have let another code path connect first - never stack
        // a second room.connect() for the same bridge identity (LiveKit: "Participant already exists").
        if (roomJoined) {
          return;
        }
        if (await connectLiveKit(fresh.wsUrl, fresh.token)) {
          console.log(
            `[voice-bridge] LiveKit joined (session ${sessionAtStart}) - KSP is connected (pcm=${pcmSockets.size}, ctl=${ctlSockets.size})`
          );
        }
      };

      let shouldScheduleRetry = false;
      try {
        await tryConnect();
      } catch (e) {
        let msg = e instanceof Error ? e.message : String(e);
        console.warn(`[voice-bridge] join failed: ${msg}`);
        shouldScheduleRetry = true;
        // Stale server-side participant after a fast tune or a race with reconnectRoom - nudge disconnect and retry once.
        if (isParticipantAlreadyExistsJoinError(e) && hasKspConnections() && !shuttingDown) {
          console.warn("[voice-bridge] retrying join after Participant-already-exists (disconnect + delay)");
          try {
            intentionalDisconnect = true;
            await room.disconnect();
          } catch {
            /* ignore */
          }
          roomJoined = false;
          intentionalDisconnect = false;
          await new Promise((resolve) => setTimeout(resolve, SESSION_REJOIN_DELAY_MS));
          if (!hasKspConnections() || shuttingDown || roomJoined) {
            return;
          }
          try {
            await tryConnect();
            shouldScheduleRetry = !roomJoined;
          } catch (e2) {
            msg = e2 instanceof Error ? e2.message : String(e2);
            console.warn(`[voice-bridge] join retry failed: ${msg}`);
          }
        }
      }
      if (shouldScheduleRetry && !roomJoined) {
        scheduleJoinRetry("join failed");
      }
    } finally {
      joinInProgress = false;
    }
  }

  /** Leave the LiveKit room without shutting the bridge down. */
  async function leaveRoom(reason: string): Promise<void> {
    if (!roomJoined) return;
    intentionalDisconnect = true;
    try {
      await room.disconnect();
    } catch {
      /* ignore: we're tearing the room link down anyway */
    }
    roomJoined = false;
    clearRemoteStreams();
    console.log(`[voice-bridge] LiveKit left - ${reason}`);
  }

  /**
   * Swap the active session id at runtime. Leaves the current LiveKit room (if
   * any) and re-joins on the new session as long as KSP is still connected.
   * Used by the `SESSION:<id>` control command - the in-game radio dial sends
   * one of these whenever the player tunes to a new channel, so the dev-mode
   * bridge (which can't be respawned with a fresh `SESSION_ID` env mid-run)
   * follows the tune instead of staying pinned to whatever it was launched
   * with. No-op if the id is unchanged so repeated dial commits don't churn
   * the LiveKit connection.
   */
  async function applySessionSwitch(nextSessionId: string): Promise<void> {
    const trimmed = nextSessionId.trim();
    if (!trimmed || trimmed === currentSessionId) {
      return;
    }
    const prev = currentSessionId;
    currentSessionId = trimmed;
    if (roomJoined) {
      await leaveRoom(`session change ${prev} -> ${trimmed}`);
    }
    if (SESSION_REJOIN_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_REJOIN_DELAY_MS));
    }
    if (hasKspConnections() && !shuttingDown) {
      await joinRoomIfNeeded();
    }
  }

  let sessionSwitchTail: Promise<void> = Promise.resolve();
  function switchSession(nextSessionId: string): Promise<void> {
    const trimmed = nextSessionId.trim();
    if (!trimmed || trimmed === currentSessionId) {
      return Promise.resolve();
    }
    sessionSwitchTail = sessionSwitchTail.then(
      () => applySessionSwitch(trimmed),
      () => applySessionSwitch(trimmed)
    );
    return sessionSwitchTail;
  }

  function hasKspConnections(): boolean {
    return pcmSockets.size > 0 || ctlSockets.size > 0;
  }

  function cancelIdleLeave(): void {
    if (idleLeaveTimer) {
      clearTimeout(idleLeaveTimer);
      idleLeaveTimer = null;
    }
  }

  /**
   * Schedule a deferred "leave LiveKit" if KSP doesn't reconnect within the
   * grace window. Re-schedules on every disconnect; cancelled the moment any
   * KSP socket reconnects.
   */
  function scheduleIdleLeave(): void {
    cancelIdleLeave();
    if (!roomJoined || hasKspConnections()) return;
    idleLeaveTimer = setTimeout(() => {
      idleLeaveTimer = null;
      if (shuttingDown || hasKspConnections()) return;
      void leaveRoom(`KSP idle for ${KSP_IDLE_GRACE_MS}ms`);
    }, KSP_IDLE_GRACE_MS);
  }

  /**
   * Refresh the LiveKit token and re-join the room with exponential backoff.
   * Used ONLY for unintentional disconnects (network blip / SFU restart),
   * NOT when we ourselves left because KSP went away.
   */
  async function reconnectRoom(): Promise<void> {
    if (shuttingDown || reconnectInProgress) {
      return;
    }
    if (roomJoined) {
      // joinRoomIfNeeded won the race while we were scheduling - do not stack connect().
      return;
    }
    reconnectInProgress = true;
    try {
      while (!shuttingDown && hasKspConnections()) {
        reconnectAttempts += 1;
        const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts - 1, 6));
        console.warn(
          `[voice-bridge] reconnect attempt ${reconnectAttempts}; sleeping ${backoffMs}ms before token refresh`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        if (shuttingDown || !hasKspConnections()) {
          return;
        }
        // After backoff, another path (PCM/CTL connect) may have already re-joined - critical
        // to skip or LiveKit returns "Participant already exists" and audio stays broken.
        if (roomJoined) {
          console.log("[voice-bridge] reconnect skipped - already joined (likely joinRoomIfNeeded won during backoff)");
          reconnectAttempts = 0;
          return;
        }
        try {
          const sessionAtStart = currentSessionId;
          const fresh = await fetchLiveKitToken();
          if (shuttingDown || !hasKspConnections() || roomJoined || sessionAtStart !== currentSessionId) {
            if (roomJoined) reconnectAttempts = 0;
            return;
          }
          if (await connectLiveKit(fresh.wsUrl, fresh.token)) {
            console.log(`[voice-bridge] reconnected to LiveKit on attempt ${reconnectAttempts}`);
            reconnectAttempts = 0;
          }
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[voice-bridge] reconnect failed: ${msg}`);
          if (isParticipantAlreadyExistsJoinError(e)) {
            // Same race from the other direction: treat as "we're effectively in" only if SDK agrees.
            try {
              intentionalDisconnect = true;
              await room.disconnect();
            } catch {
              /* ignore */
            }
            roomJoined = false;
            intentionalDisconnect = false;
            await new Promise((resolve) => setTimeout(resolve, SESSION_REJOIN_DELAY_MS));
          }
          // Loop and try again with longer backoff.
        }
      }
    } finally {
      reconnectInProgress = false;
    }
  }

  room.on(RoomEvent.Disconnected, (reason) => {
    if (shuttingDown) return;
    connectionEpoch += 1;
    const wasIntentional = intentionalDisconnect;
    intentionalDisconnect = false;
    roomJoined = false;
    clearRemoteStreams();
    if (wasIntentional) {
      console.log(`[voice-bridge] LiveKit disconnected (intentional, reason=${String(reason)})`);
      return;
    }
    console.warn(`[voice-bridge] LiveKit disconnected (reason=${String(reason)}); will reconnect if KSP is here`);
    if (hasKspConnections()) {
      void reconnectRoom();
    }
  });

  // ----- PCM downlink server (KSP connects here to receive mixed remote audio) -----
  const pcmServer = net.createServer((socket) => {
    pcmSockets.add(socket);
    safeSocketWrite(socket, `TOWER_PCM s16le ${SAMPLE_RATE} mono\n`);
    cancelIdleLeave();
    void joinRoomIfNeeded();
    const onClose = () => {
      pcmSockets.delete(socket);
      if (!hasKspConnections()) scheduleIdleLeave();
    };
    socket.on("close", onClose);
    socket.on("error", onClose);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    pcmServer.once("error", onListenError);
    pcmServer.listen(PCM_PORT, PCM_HOST, () => resolve());
    pcmServer.once("listening", () => pcmServer.off("error", onListenError));
  });
  pcmServer.on("error", (err) => {
    console.error("[voice-bridge] PCM TCP server error", err);
  });
  console.log(`[voice-bridge] PCM TCP ${PCM_HOST}:${PCM_PORT} (s16le ${SAMPLE_RATE} Hz mono)`);

  const pttEncoder = new TextEncoder();
  async function sendPttToRoom(on: boolean): Promise<void> {
    const lp = room.localParticipant;
    if (!lp || !roomJoined) {
      throw new Error("not connected to LiveKit (KSP not present?)");
    }
    const payload = pttEncoder.encode(JSON.stringify({ type: "ksp_ptt", on, from: BRIDGE_IDENTITY }));
    // Reliable delivery: PTT toggles must not be dropped under packet loss.
    await lp.publishData(payload, { reliable: true } as never);
  }

  // ----- Control uplink server (KSP sends MIC_ON / MIC_OFF / PING) -----
  const ctlServer = net.createServer((socket) => {
    ctlSockets.add(socket);
    cancelIdleLeave();
    void joinRoomIfNeeded();
    let buf = "";
    let commandQueue: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > CTL_MAX_BUFFER_BYTES) {
        safeSocketWrite(socket, "ERR control buffer overflow\n");
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        commandQueue = commandQueue.then(async () => {
          if (line === "PING") {
            safeSocketWrite(socket, "PONG\n");
            return;
          }
          if (line === "MIC_OFF") {
            kspTxSockets.delete(socket);
            try {
              await sendPttToRoom(false);
              safeSocketWrite(socket, "OK mic_off\n");
            } catch (e) {
              safeSocketWrite(socket, `ERR ${String(e)}\n`);
            }
            return;
          }
          if (line === "MIC_ON") {
            // KSP requested mic-on; opportunistically join if we hadn't yet.
            if (!roomJoined) await joinRoomIfNeeded();
            try {
              await sendPttToRoom(true);
              kspTxSockets.add(socket);
              safeSocketWrite(socket, "OK mic_on\n");
            } catch (e) {
              kspTxSockets.delete(socket);
              safeSocketWrite(socket, `ERR ${String(e)}\n`);
            }
            return;
          }
          if (line.startsWith("SESSION:")) {
            const next = parseSessionTuneCommand(line);
            if (!next) {
              safeSocketWrite(socket, "ERR session id missing\n");
              return;
            }
            try {
              await switchSession(next);
              safeSocketWrite(socket, `OK session ${currentSessionId}\n`);
            } catch (e) {
              safeSocketWrite(socket, `ERR ${String(e)}\n`);
            }
            return;
          }
          if (line.length > 0) {
            safeSocketWrite(socket, "ERR unknown command\n");
          }
        }).catch((e) => {
          safeSocketWrite(socket, `ERR ${String(e)}\n`);
        });
      }
    });
    const onClose = () => {
      ctlSockets.delete(socket);
      kspTxSockets.delete(socket);
      if (!hasKspConnections()) scheduleIdleLeave();
    };
    socket.on("close", onClose);
    socket.on("error", onClose);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    ctlServer.once("error", onListenError);
    ctlServer.listen(CTL_PORT, CTL_HOST, () => resolve());
    ctlServer.once("listening", () => ctlServer.off("error", onListenError));
  });
  ctlServer.on("error", (err) => {
    console.error("[voice-bridge] control TCP server error", err);
  });
  console.log(`[voice-bridge] control TCP ${CTL_HOST}:${CTL_PORT} (MIC_ON / MIC_OFF / PING)`);
  console.log(
    `[voice-bridge] ready - will join LiveKit on first KSP connection, leave ${KSP_IDLE_GRACE_MS}ms after the last one drops`
  );

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cancelIdleLeave();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    console.log("[voice-bridge] shutting down...");
    if (roomJoined) {
      try {
        await sendPttToRoom(false);
      } catch {
        /* ignore: tower-side will time out PTT-on if it never sees the off */
      }
    }
    intentionalDisconnect = true;
    connectionEpoch += 1;
    try {
      await room.disconnect();
    } catch {
      /* ignore */
    }
    roomJoined = false;
    clearRemoteStreams();
    try {
      await mixer.aclose();
    } catch {
      /* ignore */
    }
    await pumpMixer.catch(() => {});
    for (const s of pcmSockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    pcmSockets.clear();
    for (const s of ctlSockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    ctlSockets.clear();
    pcmServer.close();
    ctlServer.close();
    dispose();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (reason) => {
    console.error("[voice-bridge] unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[voice-bridge] uncaughtException", err);
    void shutdown();
  });

  if (KSP_WATCHDOG_ENABLED) {
    let misses = 0;
    console.log(
      `[voice-bridge] KSP watchdog enabled (${KSP_PROCESS_NAME}, interval=${KSP_WATCH_INTERVAL_MS}ms, misses=${KSP_WATCH_MISSES_BEFORE_EXIT})`
    );
    watchdogTimer = setInterval(() => {
      void (async () => {
        if (shuttingDown) {
          return;
        }
        const running = await isKspRunning();
        if (running) {
          misses = 0;
          return;
        }
        misses += 1;
        console.warn(
          `[voice-bridge] KSP process ${KSP_PROCESS_NAME} not found (${misses}/${KSP_WATCH_MISSES_BEFORE_EXIT})`
        );
        if (misses >= KSP_WATCH_MISSES_BEFORE_EXIT) {
          console.log("[voice-bridge] KSP absent; exiting bridge.");
          await shutdown();
        }
      })();
    }, KSP_WATCH_INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  dispose();
  process.exit(1);
});




