# Comms Safety Pack: Stuck Mic + Mayday - Plan

> **World scoping:** Alerts are world-agnostic in shape (severity, source, timestamps are server wall-clock per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md)) but stamped with the subject's `worldId` + `airportId` so cross-world controllers can decide whether to act (usually inform-only). Squawk is a 4-digit identifier with no coordinate component. Mayday recordings live on whichever per-airport voice frequency the pilot was tuned to.

## Purpose

Two safety surfaces that share the same plumbing (PTT-state monitoring, alert engine hookup, voice metadata messages, recording capture), shipped together as one feature pack:

- **Stuck mic detector (1.5)** - flag any participant transmitting longer than threshold; tower one-click "kill PTT" forces local mute on the offender.
- **Mayday / Pan-Pan button (1.6)** - pilot-side emergency declaration that fires a critical alert, auto-records the next 60 s of voice, freezes the strip, and auto-sets squawk 7700.

Both consume LiveKit `isSpeaking` data and both write into the future alert engine described in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 8. Pairs naturally with the squawk semantics in [IDENTITY_PLAN.md](IDENTITY_PLAN.md) (Mayday auto-sets 7700; stuck mic that triggers a 7600 transition is the same alert sink).

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) sections 1.5 + 1.6.

---

## Design intent

- **Stuck mic = nuisance, not crisis.** Default threshold 15 s. Tower gets a banner with one button. Mods can also force-mute anyone, anytime, via the existing admin path - this feature is a *fast lane* for the in-the-moment case where waiting for a mod is too slow.
- **Mayday = crisis, full alert ceremony.** One button, one confirmation tap, then everything happens automatically: alert event, recording, squawk, strip freeze, banner on every controller's screen.
- **Both surfaces share the alert engine even before it formally exists.** Build the alert event shape now (severity, source, payload, timestamps) and stub the persistence; roadmap section 8 will adopt the same shape.

Cross-references: [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md), [IDENTITY_PLAN.md](IDENTITY_PLAN.md), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 7 (timeline) + 8 (alerts), [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) (records on the *frequency* once it exists, the session room until then).

---

## Non-goals

- No automatic stuck-mic mute (false positives are worse than the cure). Tower must click.
- No "false Mayday" detection. Treat every press as real; let mods clean up after.
- No global voice cutoff button (out of scope; admin already has it).
- No phone-tree dispatch on Mayday (no SMS, no email). Just in-app alerts.

---

## Components

### 1. Shared: alert event shape (backend)

New `backend/src/services/alerts.ts`. Single shape used by every safety surface so roadmap section 8 inherits it cleanly:

```ts
type AlertSeverity = "info" | "warning" | "critical";

interface AlertEvent {
  id: string;
  severity: AlertSeverity;
  source: "stuck-mic" | "mayday" | "squawk-7700" | "squawk-7600" | "squawk-7500" | string;
  sessionId?: string;
  userId?: string;
  roomName?: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
  acknowledgedByUserId?: string;
  acknowledgedAtMs?: number;
  resolvedAtMs?: number;
  recordingUrl?: string;
  timelineEventId?: string;
}
```

Storage: Redis sorted set keyed by `createdAtMs` for the live feed; mirrored into the timeline (roadmap section 7) for replay.

API:

- `GET /v1/tower/alerts/active` - list unacknowledged + recent (last 30 min).
- `POST /v1/tower/alerts/:id/ack` (tower role).
- `POST /v1/tower/alerts/:id/resolve` (tower role).
- SSE stream `GET /v1/tower/alerts/stream` for push.

Web side: a single `useAlertsStream()` hook + a top-of-screen `AlertsBanner` component that renders the highest-severity unresolved alert. Lives in `web/src/hooks/useAlertsStream.ts` and `web/src/components/AlertsBanner.tsx`.

### 2. Stuck mic detector

#### Web detection

- New module `web/src/audio/sttDetector.ts` - despite the name, "stuck transmission detector," not speech-to-text. Tracks per-participant `isSpeaking` rising-edge timestamp from LiveKit; if `now - startedAt > thresholdMs` and still speaking, fire `onStuckStart(participant)`. On falling edge, fire `onStuckEnd`.
- Threshold default 15 000 ms; user pref overridable (5 000 - 60 000) on the tower preferences UI.
- Run only on the tower client (controllers), not on every pilot's tab - cost saving and avoids 50 banners for the same event.

#### Tower UI

[SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx) (and the equivalent in [TowerDesk.tsx](web/src/pages/TowerDesk.tsx)) gets an inline banner per stuck participant:

```
[ ! ] STUCK MIC: BOBCAT 7  - 23s  [KILL PTT]  [DISMISS]
```

Buttons:

- **KILL PTT** - calls `POST /v1/voice/force-mute` with `{ targetUserId, reason: "stuck-mic" }`. Logged.
- **DISMISS** - hides the banner for this transmission only; auto-rearms on the next `isSpeaking` rising edge.

#### Backend `force-mute` endpoint

`POST /v1/voice/force-mute` in [api.ts](backend/src/routes/api.ts):

- Tower role only.
- Publishes a LiveKit data message of kind `KIND_RELIABLE` to the target participant: `{ type: "force-mute", reason }`.
- Also writes an `AlertEvent` of severity `warning`, `source: "stuck-mic"`, `payload: { issuedByUserId, targetUserId, durationMs }`.
- Mods retain the existing kick path; `force-mute` is intentionally a softer action (no kick, no token revocation).

#### Client honors force-mute

- Web: `useVoiceForceMute()` hook listens for the data message and immediately calls `localParticipant.setMicrophoneEnabled(false)` plus shows a non-dismissible toast: "Your mic was muted by tower (stuck mic)."
- Plugin: [TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) is the in-game side. Bridge protocol gets a new inbound message `MUTE_LOCAL` from the voice bridge; the bridge subscribes to LiveKit data messages and forwards. On receipt, `TowerVoiceBridgeControl` flips its local PTT-enabled flag false and pops a one-line in-game toast through the existing screen-message channel.

#### Auto-rearm

- Tower can re-enable themselves manually via the existing voice toggle. We do *not* auto-rearm after N seconds; the explicit user action prevents the same loop firing again.

### 3. Mayday / Pan-Pan button

#### Plugin UI

[TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) gets a clearly-spaced "EMERGENCY" section at the bottom:

```
+---------------------------+
|  Emergency                |
|  [ MAYDAY ]   [ PAN-PAN ] |
+---------------------------+
```

Both buttons require a confirmation tap (label changes to `CONFIRM MAYDAY` for 3 s; second tap fires; otherwise reverts). Visual styling: bright red for MAYDAY, amber for PAN-PAN.

Posts to `POST /v1/session/:id/declare-emergency` with `{ kind: "mayday" | "pan-pan", note?: string }`.

Mirrored web button on [PilotProfile.tsx](web/src/components/PilotProfile.tsx) for pilots flying without the plugin (or with a panel hidden).

#### Backend declare-emergency

`POST /v1/session/:id/declare-emergency` in [api.ts](backend/src/routes/api.ts), pilot role only (must own the session):

1. Write `AlertEvent { severity: "critical", source: "mayday", sessionId, userId, payload: { kind, note }, createdAtMs }`.
2. Force squawk to `7700` for `mayday` (or leave existing for `pan-pan`); via the same path as [IDENTITY_PLAN.md](IDENTITY_PLAN.md) `PUT /v1/session/:id/squawk`.
3. Mark the strip as `frozen: true` in the session record - prevents the auto-archival job from sweeping it.
4. Trigger voice recording (next subsection).
5. Append a critical entry to the timeline (roadmap section 7 - until that lands, write to the existing `timeline` table the same schema).
6. Return `{ alertId, recordingTaskId }`.

Idempotent: if there's already an active mayday alert for this session, return the existing alert id without duplicating side effects.

#### Voice recording

LiveKit egress API initiated server-side from `backend/src/services/livekit.ts` (existing module - extend with `startTrackEgress`):

- Capture for 60 s.
- Output: per-participant audio in the active voice room (initially the per-session room; once [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) ships, the *frequency* room the pilot is tuned to).
- Storage: local disk first (configurable via env `RECORDINGS_DIR`); S3 / object-store integration deferred.
- On completion, attach the file URL to the `AlertEvent.recordingUrl`.

Recording survives session end - referenced from the timeline entry even after auto-archival.

#### Tower banner

The shared `AlertsBanner` (above) renders critical alerts with a louder treatment: red background, audible chime (one-shot, can be muted in tower prefs), session callsign + alert kind + elapsed time. Click expands to a card with `Acknowledge`, `Resolve`, `Open strip`.

Mayday alerts are always pinned to the top until resolved; pan-pan stays for 5 min unless extended.

### 4. Strip freeze

Adds `frozen: boolean` to the session record. Already-existing auto-archival job in [repository.ts](backend/src/services/repository.ts) skips frozen sessions. Tower can manually unfreeze from the strip card (a small lock icon appears when frozen). Resolving the alert auto-unfreezes after a 5-min grace.

### 5. Settings

Tower-side prefs (web localStorage + a tiny preferences endpoint):

- `stuckMicThresholdMs` (default 15 000).
- `stuckMicChimeEnabled` (default false).
- `maydayChimeEnabled` (default true).

Pilot-side ([TowerModSettings.cs](PluginSrc/TowerModSettings.cs)):

- `MaydayConfirmDelayMs` (default 3 000) - hold time on the second tap; minimum 1 000.

---

## Phasing

### Phase 1 - Alert event scaffolding

- `alerts.ts` service, Redis storage, the four endpoints, SSE stream.
- `AlertsBanner` component on the Tower Desk + `useAlertsStream()` hook.
- Roadmap section 8 explicitly notes adopting this shape.

Exit: a manually-injected alert (via a dev-only `POST /v1/dev/alerts/inject`) renders on every connected tower client within 1 s.

### Phase 2 - Stuck mic detector

- `sttDetector.ts` on the tower client.
- Inline banner per stuck participant.
- `force-mute` endpoint + LiveKit data-message dispatch.
- Web `useVoiceForceMute` hook.
- Plugin `MUTE_LOCAL` bridge message + [TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) handling.

Exit: hold PTT for 16 s, tower sees banner, clicks KILL PTT, mic drops within 500 ms; alert lands in the alert feed.

### Phase 3 - Mayday button

- `declare-emergency` endpoint with squawk + freeze + alert.
- Mayday section on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) with confirm-tap UX.
- Web mirror button on [PilotProfile.tsx](web/src/components/PilotProfile.tsx).
- Critical-treatment styling on the alerts banner; chime.

Exit: pilot taps MAYDAY then CONFIRM, every controller sees a red banner, strip is frozen, squawk reads 7700.

### Phase 4 - Voice recording

- Extend `livekit.ts` with track egress.
- Local-disk file storage; URL attached to alert.
- "Open recording" button on the alert card.

Exit: 60 s of post-Mayday voice playable from the alert card.

### Phase 5 - Polish + cross-wiring

- Pan-pan severity (warning, no recording, no freeze).
- Auto-resolve grace, manual unfreeze on strip.
- Auto-7600 hook for voice loss >30 s (reuses `force-mute` logic in reverse: `lostConnection` event triggers `declare-emergency` with `kind: "comms-loss"`).

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Stuck mic banner storms when LiveKit `isSpeaking` flickers | Threshold + same-event debounce: only one banner per `(participant, transmission)`. |
| Tower force-mutes the wrong participant | Banner shows callsign + duration explicitly; KILL PTT requires no confirm because the threshold already gated on time, but the action is logged and reversible (target re-enables mic via normal toggle). |
| Pilot accidentally taps MAYDAY | 3-second hold-confirm pattern; explicit "CONFIRM MAYDAY" label change. Mods can resolve + unfreeze. |
| Voice recording captures unintended ambient (mic open in other apps) | Out of scope - same risk as any voice room. Documented in pilot onboarding text. |
| LiveKit egress requires a separate API key + may be off in self-hosted dev | Egress feature behind env flag `LIVEKIT_EGRESS_ENABLED`; falls back to "recording skipped" entry on the alert. |
| Recording disk fills | Egress files kept 30 days; cron sweep older than that; configurable. |
| 7700 squawk conflict with manual override | Explicit precedence: mayday-set squawk overrides manual until alert resolved. Tower can still set a different squawk after acknowledging. |
| Alert engine interface drift before roadmap §8 lands | Build §8 *on* this module, not parallel - mark the file as the authoritative alerts source. |
| Stuck mic detector burns CPU on tower client with many participants | Single timer per participant, polled at 1 Hz; trivial. Bench at 50 participants before shipping. |
| Frozen strips clog the desk | Show frozen strips collapsed by default; "show frozen" toggle on the strip filter row. |

---

## Test plan

- 16 s held PTT triggers banner exactly once; release within 14 s does not.
- KILL PTT mutes the target on web within 500 ms; on plugin within 1 s.
- Two towers each click KILL PTT racing - second click is a no-op (target already muted).
- Mayday confirm flow: single tap shows CONFIRM, second tap within 3 s fires, second tap after 3 s reverts.
- Mayday writes alert + sets 7700 + freezes strip + starts recording in <1 s end-to-end.
- Pan-Pan: alert + no recording + no freeze.
- Egress disabled in env: alert still fires, `recordingUrl: null`, no errors.
- Recording playable from the alert card.
- Acknowledge clears the chime; resolve removes the banner.

---

## Files touched

**Backend (new)**

- `backend/src/services/alerts.ts` - alert shape, storage, dispatch, SSE.

**Backend (edits)**

- [backend/src/services/livekit.ts](backend/src/services/livekit.ts) - data-message dispatch helper, `startTrackEgress`.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - `/voice/force-mute`, `/session/:id/declare-emergency`, `/tower/alerts/*`.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - `frozen` flag on sessions; auto-archival skip.
- `backend/src/config/env.ts` - `RECORDINGS_DIR`, `LIVEKIT_EGRESS_ENABLED`, alert chime opts.

**Web (new)**

- `web/src/audio/sttDetector.ts`.
- `web/src/hooks/useAlertsStream.ts`.
- `web/src/hooks/useVoiceForceMute.ts`.
- `web/src/components/AlertsBanner.tsx`.
- `web/src/components/StuckMicBanner.tsx`.
- `web/src/components/EmergencyButtons.tsx` (mayday + pan-pan, mirrored on PilotProfile).

**Web (edits)**

- [web/src/session/SessionVoicePanel.tsx](web/src/session/SessionVoicePanel.tsx) - mount stuck-mic banner.
- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount alerts banner; lock icon on frozen strips.
- [web/src/components/PilotProfile.tsx](web/src/components/PilotProfile.tsx) - mount mayday/pan-pan buttons.

**Plugin (new)**

- None.

**Plugin (edits)**

- [PluginSrc/TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) - emergency section + confirm-tap UX.
- [PluginSrc/TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) - handle `MUTE_LOCAL` from bridge.
- [PluginSrc/TowerModSettings.cs](PluginSrc/TowerModSettings.cs) - `MaydayConfirmDelayMs`.

**Voice bridge (edits)**

- [KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts](../KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts) - subscribe to LiveKit data messages, forward `force-mute` to plugin as `MUTE_LOCAL`.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) sections 1.5 + 1.6 to point at this doc.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 8 to note it adopts this alert shape.
