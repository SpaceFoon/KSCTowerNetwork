# Voice Reliability and Tower Audio UX - Plan

> **World scoping:** Voice transport (LiveKit rooms, mic capture, mixing, metering, PTT) is world-agnostic per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). The *frequency identity* a user is tuned to is `(worldId, airportId)`-scoped via [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), but the audio-stack guarantees in this plan apply uniformly to every room a user joins.

## Purpose

[REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 1 - the Phase 0 stabilization gate. Tower operations *fail immediately* if comms are unreliable, ambiguous, or dangerously loud; this plan turns the existing prototype's "voice mostly works" into a deterministic, observable, recoverable audio stack that the rest of the feature plans (ATIS, per-frequency channels, comms safety, ground seat, handoff) can safely build on.

Six concrete capabilities to land:

1. **Deterministic voice state model.** One state machine, one shape, every surface (web + plugin + bridge) reads from it.
2. **Reliable metering.** Independent local-mic and incoming-audio level meters, sampled at the right rate to be useful, not vanity bars.
3. **PTT and press-to-mute.** First-class transmit semantics with hardware key + UI button + plugin keybind, all converging on the same publish state.
4. **Per-participant gain + mute/deafen.** Per-row volume and instant cut-off, persisted across reconnects.
5. **Reconnect and stale-participant handling.** Silent recovery under transient drops; cleanup of zombie peers; visible status when degraded.
6. **Audio safety.** Noise gate / output limiter / anti-feedback rules so a single bad mic or a Mayday shout cannot ear-blast an entire tower or feed back into a hot mic.

Plus the supporting deliverables:

- Voice status model in backend + frontend.
- Participant audio controls panel.
- Mic test wizard (device select, sensitivity, level check).
- Comms health diagnostics panel (latency, packet loss proxy, track state).

---

## Design intent

- **One state machine, one shape.** Every consumer (web `SessionVoicePanel`, plugin `TowerVoiceBridgeControl`, voice bridge process, tower diagnostics, alerts engine) reads a normalized `VoiceState` derived from the LiveKit `Room`/`Participant`/`Track` events. No surface invents its own definition of "speaking" or "connected."
- **Bridge is dumb, surfaces are smart.** The voice bridge process keeps its job small (RTC plumbing, PCM in/out, force-mute relay). Display-state derivation lives in the consumers, sourced from authoritative LiveKit events.
- **Diagnostics are first-class.** "Voice degraded" is a state, not a vibe. Latency / packet-loss-proxy / jitter / track-publish-state are visible to controllers in a compact panel and emit `info`/`warning` alerts via [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md)'s feed when thresholds breach.
- **Safety pipeline runs in series, identically on web and plugin.** Mic capture → noise gate → preamp gain → optional Kerbalizer DSP → publish. Receive → optional Kerbalizer → squelch tail ([SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md)) → per-participant gain → master limiter → output. Same order, same parameters, same defaults; the plugin is allowed to be a leaner subset but never reorders.
- **Settings persist sensibly.** Per-participant gain and mute persist per `(localUserId, remoteUserId)` in localStorage (web) / `TowerModSettings` (plugin) so reconnecting doesn't reset what the user dialed in.
- **Hot path is bounded and instrumented.** Capture buffer, jitter buffer, encoder queue, decoder queue, output ring - all bounded with explicit drop policy + a metric counter the diagnostics panel reads. No unbounded-queue audio freeze regressions.
- **Build on what exists.** [TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs), [TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs), [TowerVoiceAutoConnect.cs](PluginSrc/TowerVoiceAutoConnect.cs), [TowerVoiceBridgeRespawnQueue.cs](PluginSrc/TowerVoiceBridgeRespawnQueue.cs) already cover much of the plugin-side scaffolding; this plan formalizes the contracts and fills the gaps.

Cross-references: [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 1 + 8, [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md), [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md), [SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md), [ATIS_PLAN.md](ATIS_PLAN.md).

---

## Non-goals

- No new RTC backend. LiveKit stays. No SFU/MCU change, no WebRTC alternative.
- No real-time speech recognition / captions. Different feature; future plan.
- No multi-channel spatial audio in v1. Mono in, mono out, per-room mixing.
- No echo cancellation tuning beyond what the OS / browser provides. We expose the platform's AEC, we don't ship one.
- No platform-side recording UI in v1. Recording is the Mayday capture path in [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md).
- No bandwidth shaping / adaptive codec switching - LiveKit's defaults are good enough for v1.
- No music / audio playback unrelated to voice (sirens, announcements). ATIS owns its own bot path.

---

## Components

### 1. Voice state model

Replace the thin `VoiceParticipantRow` in [web/src/voice/types.ts](web/src/voice/types.ts) with a richer normalized shape that every UI surface (and the alerts engine) consumes:

```ts
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type TrackPublishState =
  | "unpublished"
  | "publishing"
  | "published"
  | "muted"          // still published, but locally muted at source
  | "republishing"
  | "failed";

export type TrackSubscribeState =
  | "unsubscribed"
  | "subscribing"
  | "subscribed"
  | "muted-remote"   // remote pushed a mute
  | "muted-local"    // local user deafened/muted them
  | "stalled"        // subscribed but no audio frames > thresholdMs
  | "failed";

export type VoiceParticipantRow = {
  identity: string;             // LiveKit identity (= sessionId or userId)
  userId?: string;
  displayName?: string;
  callsign?: string;
  isLocal: boolean;
  isBot?: boolean;              // ATIS / system participants
  publish: TrackPublishState;
  subscribe: TrackSubscribeState;
  isSpeaking: boolean;
  speakingSinceMs?: number;
  inputLevelDbfs?: number;      // -60..0; updated at metering rate
  outputLevelDbfs?: number;
  // Per-(local user, remote) settings, persisted:
  localGainDb: number;          // -24..+12, default 0
  isMutedLocally: boolean;      // listener-side mute (deafen this person)
  // Diagnostics:
  lastFrameAtMs?: number;
  rtt?: number;                 // ms, from LiveKit conn quality if available
  packetLossPct?: number;       // 0..100, from LiveKit stats
  jitterMs?: number;
  connQuality?: "excellent" | "good" | "poor" | "lost";
};

export type RoomVoiceState = {
  roomName: string;
  worldFreq?: { worldId: string; airportId: string; freqId: string };
  conn: ConnectionState;
  reconnectAttempt: number;
  joinedAtMs?: number;
  selfPtt: { engaged: boolean; engagedSinceMs?: number };
  selfMicMuted: boolean;
  participants: VoiceParticipantRow[];
};
```

Reducer module `web/src/voice/voiceStateReducer.ts` consumes raw LiveKit events (`ConnectionStateChanged`, `ParticipantConnected/Disconnected`, `TrackPublished/Subscribed/Muted/Unmuted`, `ActiveSpeakersChanged`, `ConnectionQualityChanged`, `Reconnecting/Reconnected`) and produces a `RoomVoiceState`. UI subscribes via a `useVoiceState(roomName)` hook.

Plugin parallel: a small JSON status frame `VOICE_STATE` from the bridge to [TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) every 1 s with the same shape (subset of fields - no per-participant local gain since the plugin doesn't render that UI).

### 2. Metering

#### Local mic metering

- Web: `MediaStreamAudioSourceNode` → `AnalyserNode` (or AudioWorklet for cleaner numbers). Sampled at 30 Hz, smoothed with a 3-frame attack / 6-frame release. Output dBFS.
- Plugin: capture-side ring buffer already exists in `TowerVoiceBridgeControl` (telemetry already touches this). Add an RMS computation per 33 ms window emitted to the GUI via `TowerRadioGui`.

#### Incoming audio metering

- Per-participant: `AudioContext` analyser on each subscribed `RemoteAudioTrack`'s `MediaStream`. 30 Hz, dBFS, attached to `VoiceParticipantRow.outputLevelDbfs`.
- Aggregate "incoming" for plugin: bridge mixes pre-output and emits one RMS dBFS per 100 ms; plugin GUI shows one inbound bar.

#### Why two meters

Tower needs to know: "Am I being heard? (input)" *and* "Is someone trying to talk to me? (output)" independently. Conflating them - common bug in our prototype - hides bad-cable / wrong-device problems.

### 3. PTT / press-to-mute / latch

Three transmit modes, user-selectable:

| Mode | Behavior |
|------|----------|
| `open` | Mic always live (default for tower seats during a session) |
| `ptt` | Hold a key (web `Space` default; plugin configurable) → publish unmute; release → mute |
| `latch` | Tap key to toggle; useful for long calls, bound to `Caps Lock` style |

Single transmit-state owner: `voiceStateReducer.selfMicMuted`. Sources of truth that flip it:

- UI mute button.
- PTT key (web global keyhandler when `selfPttHotkeyEnabled`; plugin via [TowerModSettings.cs](PluginSrc/TowerModSettings.cs) keybind).
- `force-mute` data message from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) (write-only override - clears on user manual unmute).
- Mode change.

PTT key implementation:

- Web: a singleton `PttController` with `engage()` / `release()`; debounce 50 ms on engage, 200 ms hangover on release (avoids choppy ends mid-syllable). On engage, also fires `kerchunk` if [SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md) is shipped.
- Plugin: existing key-poll loop in `TowerVoiceBridgeControl` already supports keybind; add hangover + kerchunk hook.

Visible PTT indicator: every voice surface shows a clear TX indicator (red dot + "TX" badge) when `selfPtt.engaged && !selfMicMuted && publish === "published"`. If any of those three is false while user is holding key, indicator is amber with tooltip "PTT held but not transmitting (muted/disconnected)" - prevents the "I was talking and nobody heard me" failure mode.

Push-to-mute is just the inverse mode (`open` mode + temporary mute key). Same controller, mirrored.

### 4. Per-participant audio controls

Per remote participant, the local user controls:

- **Local gain slider** -24..+12 dB, default 0. Applied via `GainNode` chained on the participant's `MediaStream`.
- **Mute (deafen this person) toggle.** Disconnects the gain output; participant remains subscribed (don't churn LiveKit subscription state); meter still runs so the row shows "speaking" without you hearing.
- **Solo toggle** (advanced, optional, Phase 5) - mutes everyone else.

UI: row in [SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx) and [VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) gets a compact slider + mute. Long-press the meter bar to expand a popover with: gain numeric, mute, solo, "reset to default", "report stuck mic" (hooks the [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) banner).

Persistence: keyed `voice.gain.{localUserId}.{remoteIdentity}` in localStorage. Plugin parallel: keyed map in [TowerModSettings.cs](PluginSrc/TowerModSettings.cs).

Quick actions: `M` = toggle mute participant under cursor; `Shift+M` = mute all; `Alt+M` = unmute all. Hotkey scope: only when [VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) or the voice panel is the focused region (avoids hijacking text-input keys).

### 5. Reconnect and stale-participant handling

#### Reconnect

- Listen for LiveKit `Reconnecting` / `Reconnected` / `Disconnected(reason)` events.
- `voiceStateReducer` flips `conn` accordingly; UI shows a non-modal banner during `reconnecting` and a toast on success.
- Reconnect attempts are bounded: 5 attempts with backoff (1s, 2s, 4s, 8s, 16s); after 5 failed, `conn` becomes `failed` and a "Rejoin" button appears.
- Reconnect path always re-publishes the local mic with the same constraints (selected device, sample rate, `noiseSuppression: false` if Kerbalizer is on - the OS's NS conflicts with our radio DSP), and re-subscribes per stored preferences.
- During `reconnecting`, local input metering keeps running so the user knows the mic itself isn't dead; output meters freeze at last value.

#### Stale-participant detection

- A `stalled` subscribe-state fires when no audio frame for that subscribed track for >5 s. UI shows the row with a faint amber dot + tooltip; metering shows -∞ dBFS.
- Auto-resub at 10 s (`unsubscribe → subscribe`).
- If still stalled at 30 s, the participant is marked `failed` and slides to the bottom of the list (kept visible because they're still officially in the room, but de-emphasized).
- "Zombie" peers (LiveKit reports them as connected but they've been silent + zero metadata for >120 s) trigger an `info`-severity alert via [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) so a tower can decide to ack & ignore.

#### Server-side cleanup

- Backend `livekit.ts` already issues tokens. Add a periodic janitor (every 60 s) that lists room participants and forcibly disconnects any whose last-known activity (per LiveKit `ParticipantInfo.joined_at` + zero published-tracks update) exceeds 5 minutes. Logged.

### 6. Audio safety pipeline

One canonical chain on each side:

#### Capture (publish) chain

1. `getUserMedia` with explicit constraints: `echoCancellation: true`, `noiseSuppression: !kerbalizerEnabled`, `autoGainControl: false`, `sampleRate: 48000`.
2. `AnalyserNode` (input meter, 30 Hz).
3. **Noise gate.** Threshold default -50 dBFS, attack 5 ms, release 150 ms. Hard mute below threshold to prevent open-mic noise floor flood. Configurable.
4. **Preamp gain.** -12..+24 dB, default 0; user-set via mic test wizard.
5. **Optional Kerbalizer chain** ([VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md) - radio filter + compander).
6. `MediaStreamDestination` → publish to LiveKit.

#### Receive (playback) chain (per participant)

1. LiveKit `RemoteAudioTrack` → `MediaStreamSource`.
2. `AnalyserNode` (output meter, 30 Hz).
3. **Optional inbound Kerbalizer DSP** if user has "Kerbalize incoming" on (per-participant or master).
4. **Optional squelch tail** ([SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md)) chained after Kerbalizer.
5. **Per-participant gain** (from settings).
6. → mixed bus.

#### Master output chain (after mixing)

1. **Master gain** (one slider for the whole voice mix).
2. **Master limiter.** Brick-wall at -1 dBFS, 1 ms attack, 50 ms release. Prevents Mayday-shouts and DSP tail spikes from driving the output above 0 dBFS regardless of any per-participant slider.
3. **Anti-feedback rule.** If the device that captures the mic is also the device that plays output AND headphones aren't detected, on first detection emit a `warning` alert ("Speakers + mic on same device may feed back"). Continues to play - we don't silently disable - but the controller is told.
4. → `AudioContext.destination`.

#### Plugin parallel

[TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs) has the receive side; extend with the same noise gate / limiter on capture and the master limiter on playback. Use Unity's `AudioMixer` for the master with a `Limiter` effect.

### 7. Mic test wizard

`web/src/components/MicTestWizard.tsx`. 4-step modal:

```
Step 1 - Pick microphone
   [ Built-in Microphone ▾ ]  (lists enumerateDevices() audioinput)
   [ Test capture ]

Step 2 - Sensitivity (level + noise gate)
   [Live VU bar -60 ──[●]── 0 dBFS]
   "Speak normally; the bar should peak around -12 to -6 dBFS."
   Preamp gain: [ slider -12 .. +24 dB, default 0 ]
   Noise gate threshold: [ slider -60 .. -20 dBFS, default -50 ]
   Suggested values shown live based on detected ambient noise + speech peaks.

Step 3 - Echo / loopback test
   "Click below; you'll hear yourself with a 1 s delay. If you hear an echo loop or
   feedback whine, switch to a headset before proceeding."
   [ Loopback test (10s) ]

Step 4 - Save
   Saved settings: device, preamp, gate, suppression on/off
   [ Apply ]
```

Persisted as `voice.mic.{userId}` in localStorage. Re-runnable from the comms panel. First-run on the lobby page if no saved settings.

### 8. Comms health diagnostics panel

`web/src/components/CommsHealthPanel.tsx`, mounted on [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) and [VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx). Compact card per active room with:

```
KSC TWR  ●●●●○  (good)
  Conn:    connected (joined 12:43Z, no reconns)
  Self:    publishing · TX off · -18 dBFS
  RTT:     34 ms     Loss: 0.1%     Jitter: 8 ms
  Inbound: 3 active (BOBCAT 7 -18, KIRBY -23, MUNFLYER 4 -52)
  Diag:    [ Run mic test ]  [ Force rejoin ]  [ Copy diagnostic bundle ]
```

Quality dots derive from LiveKit `connectionQuality` per local + lowest-quality remote.

### 9. Diagnostic bundle

"Copy diagnostic bundle" emits a JSON blob (no PII): browser, OS, audio devices (names + ids), current `RoomVoiceState`, last 60 s of metering snapshots, last 50 LiveKit events, current settings. User can paste into a bug report. Plugin parallel writes to `KSP_ROOT/Logs/voice-bundle-{timestamp}.json`.

### 10. Backend voice status surface (lightweight)

Backend doesn't *own* the voice state (LiveKit does), but it does expose a thin endpoint for external observability and for the alerts engine:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/voice/rooms/:room/participants` | List participants + their server-known state (connection quality from LiveKit webhook, last seen). |
| `GET` | `/v1/voice/health` | Aggregated counts: active rooms, participants, recent disconnect rate, recent reconnect rate. For admin dashboard + Phase 0 sign-off automation. |

Subscribes to LiveKit webhooks (`participant_joined/left`, `track_published/unpublished`, `room_started/finished`) to populate these. Janitor uses webhook misses + heartbeat to detect dead peers.

### 11. Alerts integration

Voice events that warrant the alerts feed (from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) shape):

| Event | Severity | Source |
|-------|----------|--------|
| Local mic publish failed after 5 reconnect attempts | warning | `voice-publish-failed` |
| User has been disconnected from a primary frequency >30 s | warning | `voice-disconnected` |
| Anti-feedback warning (mic+speaker same device, no headphones) | info | `voice-feedback-risk` |
| Stuck-mic detected (>15 s) | warning | (handled by [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md)) |
| Master output limiter clipped >3 times in 10 s | info | `voice-output-clip` |
| Zombie peer in room >120 s | info | `voice-zombie-peer` |

All carry `roomName` + `worldFreq` (when applicable) so cross-world tower views can decide to ignore.

---

## Phasing

### Phase 0 - Foundation: state model + reducer

- New `voiceStateReducer.ts` + `useVoiceState()` hook.
- Replace existing `VoiceParticipantRow` consumers with the new shape.
- No new UI yet; existing surfaces just consume the richer state.

Exit: `useVoiceState("test-room")` returns a `RoomVoiceState` that updates on every LiveKit event in <100 ms.

### Phase 1 - Metering

- AnalyserNode per local mic + per remote track, 30 Hz, dBFS.
- `inputLevelDbfs` / `outputLevelDbfs` populated on rows.
- VU bars on every participant row (compact mode = thin colored bar; expanded = 12-segment LED-style).
- Plugin parallel: input + aggregate inbound dBFS in [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs).

Exit: speaking visibly moves the bar at 30 Hz with no audible glitch.

### Phase 2 - PTT + transmit semantics

- `PttController` singleton + key handler with debounce/hangover.
- Three modes (open / ptt / latch) selectable from preferences.
- TX indicator with the three-state semantic (off / TX / TX-but-blocked).
- Plugin keybind already exists; align hangover + indicator visuals.

Exit: PTT in a room with two browsers + plugin works correctly; release-trim avoids cut syllables; held-but-blocked state fires when muted by tower.

### Phase 3 - Per-participant gain + mute/deafen + persistence

- `GainNode` per remote track + persisted settings.
- Mute (deafen) toggle, keep subscription alive.
- Hotkeys `M` / `Shift+M` / `Alt+M`.
- Settings UI in expanded participant row.
- Plugin: per-remote-identity gain dictionary in [TowerModSettings.cs](PluginSrc/TowerModSettings.cs).

Exit: muting a participant + reconnecting + rejoining preserves the mute.

### Phase 4 - Reconnect + stale-participant handling

- Bounded reconnect with backoff, banner during, toast on success, "Rejoin" button on failed.
- `stalled` detection at 5 s, auto-resub at 10 s, mark failed at 30 s.
- Server-side janitor (60 s sweep, 5 min stale threshold).
- Webhook subscription on backend.

Exit: mid-call WiFi drop recovers transparently within 10 s; pulled USB mic shows "publish failed" with a Rejoin button.

### Phase 5 - Audio safety + master chain

- Capture-side noise gate with sane defaults.
- Master limiter (brick-wall -1 dBFS).
- Anti-feedback detection on first device pair.
- All three on plugin via Unity AudioMixer.

Exit: shouting "MAYDAY" doesn't peg output; quiet tower room doesn't bleed mic noise.

### Phase 6 - Mic test wizard + comms health panel

- 4-step wizard mounted on lobby first-run + accessible from comms panel anytime.
- `CommsHealthPanel` on TowerDesk + VoiceDesk.
- Diagnostic bundle export.

Exit: a new user can go from "no idea if my mic works" to "verified at -12 dBFS peaks, gate at -50, no echo" in under 60 s.

### Phase 7 - Backend status surface + alerts integration

- `/v1/voice/rooms/:room/participants` and `/v1/voice/health`.
- LiveKit webhook handler.
- Alert emit hooks for the six listed events.

Exit: roadmap §1 deliverables complete; Phase 0 stabilization gate clears.

---

## Defaults

Carefully chosen because each one moves the median user from "broken" to "fine" without making the advanced user fight us:

| Setting | Default |
|---------|---------|
| Transmit mode | `open` for controller seats, `ptt` for pilots |
| PTT key (web) | Space |
| PTT release hangover | 200 ms |
| Noise gate threshold | -50 dBFS |
| Noise gate attack / release | 5 ms / 150 ms |
| Mic preamp | 0 dB |
| `echoCancellation` | true (browser/OS path) |
| `noiseSuppression` | true unless Kerbalizer is on |
| `autoGainControl` | false (we want predictable levels) |
| Per-participant gain | 0 dB |
| Master gain | 0 dB |
| Master limiter | -1 dBFS, 1 ms / 50 ms |
| Reconnect attempts | 5, backoff 1/2/4/8/16 s |
| Stalled track threshold | 5 s |
| Auto-resub | 10 s |
| Mark failed | 30 s |
| Server janitor sweep | 60 s |
| Server stale threshold | 5 min |

All overridable per user; tower preferences page (new) gathers them.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| AudioWorklet not available in some browsers | AnalyserNode fallback; degrade smoothness, not function. |
| `getUserMedia` constraint mismatch silently drops to lower sample rate | After acquisition, log actual track settings; surface mismatch in diagnostic bundle. |
| OS-level NS fights the Kerbalizer | Disable NS when Kerbalizer is enabled; document this in the wizard. |
| LiveKit webhook delivery flaky | Janitor + client heartbeat are the source of truth; webhook is an optimization. |
| Master limiter audibly pumps under sustained loud audio | 50 ms release is fast enough to be transparent for voice; tunable in advanced prefs if a controller dislikes it. |
| Anti-feedback false positive on headphone-with-mic combo devices | Detection is `microphone.deviceId.groupId === audiooutput.deviceId.groupId` AND no "headphones"/"headset" hint in the device label - a heuristic; the warning is non-blocking and dismissible. |
| Per-participant gain stack overruns master limiter (lots of high-gain rows) | Limiter is the last stage; can't overrun. UI clips slider to +12 dB to prevent extreme local gains that just get squashed. |
| Plugin AudioMixer doesn't perfectly match web DSP | Goal is parity of *rules*, not bit-exact audio; tower mostly uses web. Plugin matches gate threshold and limiter ceiling at minimum. |
| Reconnect storm if the LiveKit server has a global hiccup | Backoff is exponential, capped at 16 s; after 5 attempts user is asked to manually rejoin so a failed cluster doesn't get DDoSed by clients. |
| Mic test wizard hijacks first-run for users who already have a working setup | Wizard is *suggested* on first run via dismissible banner, not modal; advanced user can ignore. |
| Per-participant settings grow unboundedly | Keyed per remote identity which is stable and small (max a few hundred per user); periodic GC removes entries for participants the user hasn't seen in 90 days. |
| Comms health panel CPU on map-heavy desktops | 30 Hz metering only when panel is mounted; 5 Hz when collapsed. Profiled at 50 participants before shipping. |
| `force-mute` from tower (COMMS_SAFETY_PLAN) races with user manual unmute | Server-side flag wins for 30 s, then user unmute is allowed; documented + tested. |
| Multi-room voice (per-frequency channels) makes "self mute" ambiguous | `selfMicMuted` is per-room; UI shows mute button per primary frequency; monitored frequencies don't have a publish state. |
| Voice safety pipeline overhead on weak laptops | Each stage measured in microseconds at 48 kHz mono. Bench at first run; degrade by disabling Kerbalizer (the only non-trivial stage) if frame drops detected. |

---

## Test plan

- 20+ minutes of active comms, no audio freeze in plugin or web (Phase 0 exit criterion from roadmap).
- Voice connect/disconnect recovery in <5 s under transient WiFi drop (roadmap exit criterion).
- VU bars update visually within 100 ms of speech onset.
- PTT release does not cut syllables ≤ 200 ms after key release (verified by record + waveform inspect).
- Held PTT while tower force-mutes → indicator turns amber + tooltip shows reason.
- Per-participant mute persists across reconnect.
- Disconnect a participant's network for 8 s → row goes `stalled`; reconnects within 12 s; row recovers without local user action.
- Pull mic mid-call → publish-failed banner + Rejoin button; rejoining re-publishes with the same constraints.
- Speak at 0 dBFS into mic → published audio does not exceed -1 dBFS at any subscriber.
- Open mic in noisy room with gate at -50 → background noise audibly suppressed, voice intact.
- Mic + speaker on same device, no headphones → anti-feedback `info` alert lands once per session.
- Mic test wizard end-to-end <60 s.
- Diagnostic bundle parseable, contains the documented fields, no PII (no transcripts, no cookies, no audio).
- Backend `/v1/voice/health` reflects 5+ active rooms within 5 s of changes.
- Two browsers + plugin in one room: state, mute, gain, PTT consistent across all three.
- Multi-room (Phase 5 of [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)): mute on Tower freq does not affect Ground freq.

---

## Files touched

**Backend (new)**

- `backend/src/services/livekitWebhook.ts` - subscribe to LiveKit room/participant/track webhooks; populate cache + emit alert hooks.
- `backend/src/services/voiceJanitor.ts` - 60 s sweep for stale peers.
- `backend/src/services/voiceHealth.ts` - aggregate counts for `/v1/voice/health`.

**Backend (edits)**

- [backend/src/services/livekit.ts](backend/src/services/livekit.ts) - export `forceDisconnect(participantId)`; existing token issuer unchanged.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - `/v1/voice/rooms/:room/participants`, `/v1/voice/health`, webhook receiver.
- `backend/src/config/env.ts` - `VOICE_JANITOR_INTERVAL_MS`, `VOICE_JANITOR_STALE_MS`, webhook signing secret.

**Web (new)**

- `web/src/voice/voiceStateReducer.ts`.
- `web/src/voice/useVoiceState.ts`.
- `web/src/voice/PttController.ts`.
- `web/src/voice/audioGraph.ts` - canonical capture + receive + master chain.
- `web/src/voice/noiseGate.ts` - AudioWorklet processor + AnalyserNode fallback.
- `web/src/voice/limiter.ts` - master limiter.
- `web/src/voice/antiFeedback.ts` - device-pair detection.
- `web/src/components/MicTestWizard.tsx`.
- `web/src/components/CommsHealthPanel.tsx`.
- `web/src/components/ParticipantRow.tsx` - canonical row, replaces inline rendering.
- `web/src/components/TxIndicator.tsx`.
- `web/src/components/VuMeter.tsx`.

**Web (edits)**

- [web/src/voice/types.ts](web/src/voice/types.ts) - new state shape.
- [web/src/voice/livekit.ts](web/src/voice/livekit.ts) - hook reducer to all relevant events.
- [web/src/session/SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx) - swap to `ParticipantRow`, mount VU + gain + mute, mount TxIndicator.
- [web/src/pages/VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) - mount `CommsHealthPanel`, expanded participant view.
- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount compact `CommsHealthPanel`.
- [web/src/pages/RoomPage.tsx](web/src/pages/RoomPage.tsx) - first-run wizard banner.

**Plugin (edits)**

- [PluginSrc/TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) - emit `VOICE_STATE` JSON every 1 s; honor `force-mute`; align PTT hangover.
- [PluginSrc/TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs) - master limiter via Unity AudioMixer; per-remote gain dictionary read.
- [PluginSrc/TowerVoiceAutoConnect.cs](PluginSrc/TowerVoiceAutoConnect.cs) - bounded reconnect with backoff; align attempt counts.
- [PluginSrc/TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) - input + inbound VU bars; TX indicator visuals; quick mute/deafen rows.
- [PluginSrc/TowerModSettings.cs](PluginSrc/TowerModSettings.cs) - mic preamp, gate threshold, transmit mode, PTT key, per-remote gain map, mute map.

**Voice bridge (edits)**

- [KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts](../KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts) - capture/receive RMS emit; subscribe LiveKit data messages for `force-mute` already covered in [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md); add bounded queue on PCM in/out with explicit drop-counter; expose drop counters in heartbeat.

**Cross-link**

- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 1 to point at this doc and note the Phase 0 stabilization gate is owned by it.
- Update [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md) to point at this doc as the authoritative source for state model + safety pipeline.
- Update [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) to note that multi-room voice state inherits the per-room shape defined here.
- Update [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) to note that `force-mute` is implemented inside the canonical PTT/transmit-state owner from here.
- Update [SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md) to note placement after Kerbalizer in the canonical receive chain defined here.
