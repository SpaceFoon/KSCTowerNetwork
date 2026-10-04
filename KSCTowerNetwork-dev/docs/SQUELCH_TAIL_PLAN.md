# Squelch / Static Tail - Plan

## Purpose

Add the short burst of pink noise + "kerchunk" that plays when a real radio's PTT is released (and a smaller click when it's pressed). It's the single biggest perceived-realism upgrade to the voice chain - voice goes from "Discord with effects" to "actually sounds like ATC" with maybe 30 lines of DSP.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 1.4.

---

## Design intent

When a real radio key is released, the receiver hears:

1. A sharp tail of carrier-cut noise as the squelch closes (~150 ms).
2. Sometimes a low "kerchunk" thump from the relay.

When pressed, much subtler: a tiny click as the squelch opens (~50 ms), often inaudible.

We synthesize both client-side, mixed into the *received* audio of every speaker (not the speaker's own monitor). Speaker-side rendering would let us pre-compute and broadcast, but per-listener rendering is simpler and means each user can disable it without bothering anyone else.

Cross-references: [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) (entry); [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md); [KerbalizerControls.tsx](web/src/audio/KerbalizerControls.tsx) (chains alongside this).

---

## Non-goals

- Not authentic radio modeling. Not modulating real noise floor or simulating signal strength.
- No per-channel squelch profiles in v1 (could add: aviation hand-mic vs CB twang vs UHF military).
- Not server-rendered. Each listener generates locally.

---

## Components

### 1. Web: `SquelchTail` audio node

New module `web/src/audio/squelchTail.ts`.

Built on Web Audio API; chains *after* the Kerbalizer in [KerbalizerControls.tsx](web/src/audio/KerbalizerControls.tsx) so the noise burst itself gets the same radio bandpass treatment as the voice it follows.

Per-participant graph:

```
remoteVoice -> kerbalizerChain -> destinationGain -> speakers
                                       ^
                                       +-- squelchTail mix (gain-controlled noise burst)
```

Triggered by tracking each participant's `isSpeaking` state from LiveKit:

- On `isSpeaking` rising edge: schedule a 50 ms pre-roll click at -18 dB at `currentTime + 5 ms`.
- On `isSpeaking` falling edge: schedule a 150 ms tail at `currentTime` (matches end of voice precisely; LiveKit reports falling edge with ~30-100 ms grace which already lines up).

Click + tail are pre-generated once at init from a small pink-noise buffer + an ADSR envelope, cached as an `AudioBuffer`. Playback is just `BufferSource.start()`.

Optional: a second buffer with a low (200 Hz) "kerchunk" thump enveloped at the start of the tail. Off by default; user pref to enable.

### 2. User pref

Three settings on the voice panel ([SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx)):

- `Squelch tail` toggle (default on).
- `Kerchunk` toggle (default off).
- `Tail volume` slider (default -6 dB relative to voice).

Persisted in localStorage.

### 3. Plugin side (KSP voice playback)

[TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs) is a streaming PCM player that pulls from the local voice bridge TCP socket. To add the same effect in-game:

- New helper `SquelchSamples` that returns a pre-generated `short[]` buffer for the tail (and click + kerchunk variants).
- The playback callback monitors a "voice gate" derived from the incoming PCM RMS over a short window (~100 ms). On high-to-low transition (someone stopped talking) below `_lastOutputRms` threshold, append the tail buffer into the sample queue.
- On low-to-high transition, prepend the click.
- Generated once at startup from a deterministic seed so the same buffer plays every time. ~10 KB of memory.
- Settings additions in [TowerModSettings.cs](PluginSrc/TowerModSettings.cs): `SquelchTailEnabled`, `SquelchKerchunkEnabled`, `SquelchTailVolume`.
- Settings UI on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) - 2 toggles + 1 slider.

### 4. ATIS interaction

ATIS bot (from [ATIS_PLAN.md](ATIS_PLAN.md)) loops continuously - never has a true PTT release - so squelch tail logic should *not* fire on ATIS audio.

- Web side: skip the tail rendering for any participant whose identity is `atis-*`.
- Plugin side: same identity-based suppression in the bridge protocol.

---

## Phasing

### Phase 1 - Web side, single buffer

- `squelchTail.ts` with a single tail buffer.
- Hook into LiveKit `isSpeaking` events.
- On/off toggle in voice panel.

Exit: voice transmissions end with the noise tail; toggling off disables it cleanly.

### Phase 2 - Web side, full feature

- Pre-roll click.
- Optional kerchunk.
- Tail volume slider.
- ATIS suppression.

Exit: feature parity with what the plan describes; adjustable from the UI.

### Phase 3 - Plugin side

- Sample buffer generators in C# (port of the JS).
- RMS-based voice-gate detection in [TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs).
- Settings UI on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs).

Exit: in-game voice has the same squelch tail as the web client.

### Phase 4 - Polish

- Multiple squelch profiles (aviation / CB / military) selectable per channel - depends on per-frequency channels [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md).
- Subtle randomization of tail length (+/- 30 ms) so consecutive transmissions don't sound mechanical.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Tail overlaps next speaker's transmission and sounds like a phantom | Cap tail to 150 ms; if a new `isSpeaking` event arrives during tail playback, fade tail out over 30 ms. |
| Listener fatigue from constant clicks | Default tail volume conservative (-6 dB rel); user can disable; off by default for accessibility. |
| LiveKit `isSpeaking` jitter triggers spurious tails | Debounce: require >100 ms of `!isSpeaking` before firing the tail. |
| In-game RMS gate misfires on quiet voice or background noise | Calibrate threshold relative to recent peak; mirror existing `_lastOutputRms` smoothing in [TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs). |
| ATIS bot's permanent stream gets a tail every time it loops the file | Hard-suppress on identity prefix `atis-*`. |
| CPU cost on low-end web clients with many speakers | Buffer is pre-generated; per-trigger cost is one `BufferSource.start()`. Negligible even with 20 speakers. |

---

## Test plan

- Single speaker: voice ends, tail plays, ends within 200 ms total.
- Rapid PTT cycle (<100 ms gap): tail is suppressed / faded; no overlapping noise.
- Two speakers transmitting back-to-back: each gets their own tail, no doubling.
- ATIS in the room: no tails on ATIS.
- Toggle off mid-call: next transmission has no tail; previous tail completes cleanly.
- Plugin side: same scenarios via in-game PTT.

---

## Files touched

**Web (new)**

- `web/src/audio/squelchTail.ts` - tail/click/kerchunk buffer generation + scheduler.

**Web (edits)**

- [web/src/audio/KerbalizerControls.tsx](web/src/audio/KerbalizerControls.tsx) - chain the squelch node into the per-participant graph.
- [web/src/session/SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx) - 2 toggles + 1 slider, localStorage-persisted.

**Plugin (edits)**

- [PluginSrc/TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs) - voice-gate detection + tail injection in the sample queue.
- [PluginSrc/TowerModSettings.cs](PluginSrc/TowerModSettings.cs) - 3 new keys.
- [PluginSrc/TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) - settings UI.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 1.4 to point at this doc.
