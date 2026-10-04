# Mission Ops Seats: Range Safety + Recovery + CapCom - Plan

> **World scoping:** Inherits position scoping from [HANDOFF_PLAN.md](HANDOFF_PLAN.md) and frequency scoping from [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), both `(worldId, airportId)`-keyed per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). Recovery splashdown coords + downrange polygons are world-scoped (drift estimates use the subject's `worldId` to look up sea-state assumptions). CapCom subrooms are per-mission, world-agnostic in shape but stamped with the host vessel's `worldId`. User-level `controllerScopes` remain world-agnostic.

## Purpose

Make catalog sections 4.4 (Range Safety Officer), 4.5 (Recovery / SAR coordinator), and 4.6 (CapCom) real, with one important twist: **a single tower controller can hold multiple positions simultaneously**, not just swap between them. This matches small-field reality where one human runs Tower + Ground + Approach as a "combined position."

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) sections 4.4 / 4.5 / 4.6, with a new constraint (concurrent positions) layered on top of the foundations from [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md), [HANDOFF_PLAN.md](HANDOFF_PLAN.md), and [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md).

## Foundations already in place (or planned)

These plans do most of the heavy lifting; this plan threads them together:

- [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md) - introduced `controllerScopes: ControllerScope[]` (an array, not a single value). Multi-role at the *capability* layer is already designed; this plan extends the scope vocabulary and makes the "active position set" plural at the *runtime* layer.
- [HANDOFF_PLAN.md](HANDOFF_PLAN.md) - position model with `frequencyId` + `stripFilter` per position. Ownership is per-position (Redis `SET NX` keyed by position id), so a user holding multiple positions is a natural extension — no race-condition surface change.
- [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) - multi-room LiveKit grants (one primary TX + N monitor RX). The "monitor multiple, transmit on one" model is already part of that plan; concurrent positions is just "active TX = the one tied to the user's active position."
- [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) - per-position write scope already enforced server-side; concurrent positions get the union of write scopes for whichever positions they currently hold.

So most of the framework already exists. This plan is mostly: **(a) the new scope/position vocabulary**, **(b) the concurrent-positions runtime model**, **(c) the seat-specific UIs and data flows**.

---

## Design intent

- **Concurrent positions, not fast-swap.** A user with `controllerScopes: ["tower", "range-safety", "recovery", "capcom"]` can `claim` all four simultaneously. They appear as four chips in the PositionBar; the user picks one as their *active TX position* (where their voice transmits and which clearance buttons are highlighted) but receives RX + alerts from all four. This is the "combined position" pattern from real ATC.
- **One user, many seats; one seat, one user.** Position ownership stays exclusive per position (existing `SET NX` semantics). Two users cannot both be Range Safety. But one user can be Range Safety AND Tower AND CapCom for mission Foo.
- **Active TX position is the single source of truth for voice routing.** Multiple held positions → multiple monitored frequencies → exactly one transmit frequency. Switching active TX is a one-click PositionBar action with a sub-second voice retune (per [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) sub-second tune knob target).
- **Each seat owns a *write scope*; the user gets the union.** Range Safety can scrub countdowns + write downrange polygons. Recovery can mark vessels recovered + edit splashdown polygons. CapCom can post mission-elapsed-time annotations. A user holding all three gets all three permissions; the server enforces per-action regardless of which seat is "active TX" right now.
- **CapCom is special: it's per-mission, not per-airport.** Range Safety and Recovery are airport-scoped positions (one RSO per `(worldId, airportId)`). CapCom is mission-scoped: one CapCom per crewed *vessel*, in a private LiveKit subroom with that vessel's pilot. Multiple CapCom seats can exist concurrently across the system (one per active crewed mission). One user can hold many CapCom seats at once if they're flying solo as control.
- **The scope vocabulary doesn't blow up authorization checks.** Existing `roleAtLeast` / capability checks stay role-based (`controller`); scope checks are layered on top inside the position-claim and write-scope endpoints. Adding `range-safety`, `recovery`, `capcom` is three new strings, not three new roles.
- **Don't ship the seats without the data.** RSO needs trajectory + downrange position. Recovery needs splashdown + drift. CapCom needs life support + crew health. Phase 4 of [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md) is the data side; this plan's Phase 3 is the consumer.

Cross-references: [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md), [HANDOFF_PLAN.md](HANDOFF_PLAN.md), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md), [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md), [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) §6 (handoff) + §7 (timeline) + §8 (alerts), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) §4.4 / §4.5 / §4.6.

---

## Non-goals

- **No real-time ballistic prediction.** Range Safety abort decisions surface trajectory + altitude + downrange distance; the human decides. Predicted impact zones are stretch-goal Phase 6, not core.
- **No automatic abort triggers.** The RSO's abort button is human-in-the-loop. We never auto-fire `ActionGroup.Abort`.
- **No on-vessel pilot-physics for recovery.** Drift estimates are surface-current heuristics + last-known velocity. We don't simulate parachute drift forward.
- **No CapCom voice-to-text.** CapCom subroom is voice + text chat, no transcription. (Could pair with the planned checklist STT in catalog 2.2 later.)
- **No more than 4 concurrent positions per user.** Cap is product-tested ergonomics; PositionBar UI breaks past 4 chips. Configurable, but defaults to 4.
- **No "split brain" handoff.** Concurrent positions does not mean two users sharing one position. Same exclusive ownership as today.

---

## Components

### 1. Scope vocabulary expansion

Extend the `ControllerScope` union from [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md):

```ts
type ControllerScope =
  | "all"            // wildcard, default for legacy users
  | "tower"
  | "ground"
  | "approach"       // reserved for catalog 4.2
  | "range-safety"
  | "recovery"
  | "capcom";
```

Admin user editor in [AdminDesk.tsx](web/src/pages/AdminDesk.tsx) gets multi-select chips for the new scopes. Existing `all`-scope controllers transparently get the new seats (back-compat).

### 2. Position registry expansion

Extend `backend/data/positions.json` (from [HANDOFF_PLAN.md](HANDOFF_PLAN.md)):

```jsonc
[
  { "id": "tower-ksc",     "displayName": "KSC Tower",    "frequencyId": "freq-twr-ksc",    "stripFilter": "air-domain",       "requiredScope": "tower",        "kind": "airport-fixed" },
  { "id": "ground-ksc",    "displayName": "KSC Ground",   "frequencyId": "freq-gnd-ksc",    "stripFilter": "ground-domain",    "requiredScope": "ground",       "kind": "airport-fixed" },
  { "id": "rso-ksc",       "displayName": "KSC Range",    "frequencyId": "freq-rng-ksc",    "stripFilter": "rocket-ascent",    "requiredScope": "range-safety", "kind": "airport-fixed" },
  { "id": "recovery-ksc",  "displayName": "KSC Recovery", "frequencyId": "freq-rec-ksc",    "stripFilter": "post-splashdown",  "requiredScope": "recovery",     "kind": "airport-fixed" }
]
```

CapCom positions are *not* in this static file — they're created dynamically per crewed mission (Component 6).

New `kind` field distinguishes airport-fixed positions (one per `(worldId, airportId)`) from `mission-dynamic` (one per active crewed vessel). Defaults to `airport-fixed` for back-compat.

### 3. Concurrent-positions runtime model

The single biggest change to [HANDOFF_PLAN.md](HANDOFF_PLAN.md): a user can hold N positions instead of 1.

**Server side** ([backend/src/services/positions.ts](backend/src/services/positions.ts) from HANDOFF_PLAN):

- Position ownership state stays per-position-id (Redis key: `position:{positionId}:owner` → userId). No change to ownership exclusivity.
- New per-user "held positions" set (Redis: `user:{userId}:positions` → set of positionIds). Maintained as a side effect of claim/release; used for fan-out queries ("list every position this user owns").
- New per-user "active TX position" key (Redis: `user:{userId}:activeTx` → positionId). Defaults to the most recently claimed position. Updated by an explicit endpoint.

New endpoints:

- `POST /v1/tower/positions/:id/claim` — already exists (HANDOFF_PLAN). Now appends to the user's held set instead of replacing it. Enforces `controllerScopes` includes the position's `requiredScope` (or `all`). Caps at `MAX_CONCURRENT_POSITIONS_PER_USER` (default 4).
- `POST /v1/tower/positions/:id/release` — already exists. Removes from the held set. If released position was the active TX, server auto-promotes the most recently claimed remaining position; if none, active TX clears.
- `POST /v1/tower/positions/:id/activate-tx` — new. Sets active TX position. Must be in the user's held set. Side effect: voice service rebinds the LiveKit primary track to the new frequency (sub-second per PER_FREQUENCY_CHANNELS_PLAN target).
- `GET /v1/tower/positions/me` — returns the user's full held-positions list, the active TX, the union of write scopes, the union of strip filters, and the union of monitored frequencies.

### 4. Voice routing for concurrent positions

[PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) already designed multi-room grants ("one primary, N monitors"). Concurrent positions is "primary = frequency of the active TX position; monitors = frequencies of all other held positions."

LiveKit token issuance (`issueLiveKitToken`):

- For each held position, grant subscribe + publish on its frequency room.
- Server-side metadata channel emits a `tx-position-changed` data message when active TX flips, so the web client knows which room is currently the publish target. Web flips a single boolean per room (`canPublish`).
- The plugin radio panel honors a single PTT but keys publish only into the active TX room.

Edge cases:

- **Cross-frequency emergency overhear.** A held but non-active monitor frequency carrying a Mayday plays at +6 dB and visually marks the chip red on the PositionBar. Click to switch active TX, the PTT is now over there.
- **Held positions with the same frequency.** Position registry MUST have unique `frequencyId` per held set, OR the dedupe collapses to one room grant. (Currently no collision in the static registry; CapCom subrooms are per-mission so unique.)

### 5. PositionBar UI (concurrent variant)

[HANDOFF_PLAN.md](HANDOFF_PLAN.md)'s PositionBar shows the user's held position. Concurrent variant shows N chips:

```
[ TOWER (ACTIVE) ]  [ RSO ]  [ CAPCOM: ARROW-1 ]   + Add position…
```

- Chip styling: filled accent for active TX, outlined for monitored, red border + chime for held positions with an unresolved alert.
- Click a non-active chip → switches active TX.
- Right-click / "..." menu → release just that position.
- "+ Add position…" opens a popover listing claimable positions filtered by `controllerScopes`.
- Hard cap at `MAX_CONCURRENT_POSITIONS_PER_USER` chips before "+ Add" disables.

### 6. CapCom: per-mission dynamic positions

CapCom positions don't exist in `positions.json`. They're created on demand:

- Trigger: any crewed vessel becomes "active" (telemetry frame with `crewCurrent > 0` AND `situation` is `ORBITING / SUB_ORBITAL / ESCAPING`).
- Server creates a position record `capcom-mission-{vesselId}` with `frequencyId: "freq-cc-{vesselId}"` (LiveKit subroom name), `stripFilter: "vessel:{vesselId}"`, `requiredScope: "capcom"`, `kind: "mission-dynamic"`.
- A user with `capcom` scope sees these in the "+ Add position…" popover, filtered by world.
- Auto-archived 5 minutes after the vessel lands AND the position is unclaimed.

CapCom desk (Component 7c) shows MET clock, life-support countdowns from [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md) Phase 4, crew dose chips, storm window, plus the existing chat + voice subroom.

### 7. Seat-specific desks (UI variants)

[GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md) §6 introduced "TowerDesk scope variant." Same pattern, three more variants. Each variant shares the existing TowerDesk chrome (map, telemetry table, comms card, chat) but swaps the workflow column.

#### 7a. Range Safety Desk (`scope = range-safety`)

Workflow column:

- **Trajectory tape** — vertical-speed + AoA + altitude trend over the last 60 s (data already in telemetry frames).
- **Downrange distance** to KSC + ground track polyline on the map.
- **Downrange exclusion zones** — server-stored polygon set per `(worldId, airportId)`; RSO can edit. Renders as red-hatched polygons on the map.
- **HOLD button** — pushes a hold-countdown command (existing `TowerCountdownState.cs` plumbing) to the active session. Sub-button: SCRUB (publishes a 0-length countdown, clears the HUD).
- **ABORT button** — bright red, requires confirm-tap (3 s hold). Issues an `AlertEvent { severity: "critical", source: "rso-abort", payload: { issuedByUserId, reason } }` AND publishes a LiveKit data message `{ type: "rso-abort" }` that the plugin can render as a HUD banner. Does NOT auto-fire `ActionGroup.Abort` (non-goal); the pilot decides.
- **Phase-of-flight chip**: PRE-LAUNCH / LIFTOFF / MAX-Q / STAGE-SEP / ORBIT-INSERTION / SAFE-ABORT-WINDOW / ZONE-OF-EXCLUSION. Derived server-side from telemetry (altitude + vertical speed bands).

#### 7b. Recovery Desk (`scope = recovery`)

Triggered by a vessel hitting `situation: SPLASHED` or `situation: LANDED` post-flight. Workflow column:

- **Splashdown chip** — coords, biome, sea state (sea state is a stub: hardcoded "Calm" for now, hooks for Kerbalism/MAS later).
- **Drift estimate** — last-known surface velocity carried forward at a configurable decay (default 50% per minute). Renders as an arrow on the map plus a 95% probability ellipse that grows with elapsed minutes since splashdown.
- **Recovery state chip**: SPLASHED / DRIFTING / RECOVERED / LOST.
- **Mark recovered** button — writes `recovery_state = RECOVERED`, alerts resolved, vessel removed from drift display.
- **SAR coordination chat** — separate conversation pinned to the recovery position; auto-includes splashdown coords + crew manifest as the first message.

#### 7c. CapCom Desk (`scope = capcom`, mission-dynamic position)

- **MET clock** — driven by `universalTime` field; format MM:DD:HH:MM:SS from mission start.
- **Crew manifest** — names + (when [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md) Phase 4 ships) per-crew dose + stress chips.
- **Life support strip** — O2 / H2O / food / EC seconds remaining as horizontal bars; amber under 1 hour, red under 5 minutes.
- **Habitat readout** — pressure + breathable + CO2 ppm.
- **Storm warning panel** — visible only when `kerbalism.storm.incoming === true`. Shows ETA + expected duration as a countdown.
- **Annotation log** — CapCom posts timestamped entries (e.g. "Burn complete, 142 m/s residual") that go into the timeline (REAL_TOWER_ROADMAP §7) and into the CapCom subroom chat.
- **Subroom voice** — private LiveKit room with the pilot. Other concurrent positions held by this user are still RX-monitored on their respective rooms.

### 8. Alert routing for concurrent positions

The `useAlertsStream()` hook from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) currently fans out all alerts to all controllers. With concurrent positions, alert filtering becomes per-position:

- Each position has an alert filter (e.g. RSO listens for `rso-*` and `kerbalism-failure`; CapCom listens for `kerbalism-failure` + `crew-health-*`; Recovery listens for `splashdown` + `lost-craft`; Tower keeps the existing broad filter).
- A user holding multiple positions gets the union of filters.
- AlertsBanner groups by source-of-relevance: critical from any held position pins to the top; same-source alerts collapse to a single banner with a per-position chip.
- Acknowledging an alert is per-(user, alert), not per-position.

### 9. Strip filters for concurrent positions

Same union pattern as alerts. [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md)'s `stripFilters.ts` already returns a filtered strip set per position; concurrent positions returns the union, with a position chip on each strip card showing which seat owns the strip's current phase.

---

## Settings + tunables

Backend env:

- `MAX_CONCURRENT_POSITIONS_PER_USER` (default 4) - hard cap per user.
- `RECOVERY_DRIFT_DECAY_PER_MIN` (default 0.5) - velocity decay for the drift estimate ellipse.
- `RSO_ABORT_REQUIRES_REASON` (default true) - require a free-text reason on the ABORT button.
- `CAPCOM_AUTO_ARCHIVE_GRACE_MIN` (default 5) - minutes after landing before an unclaimed CapCom position is archived.

Per-user (stored in `users.preferences_json`):

- `defaultActiveTxPosition` - which position auto-becomes active TX on first claim of the session.
- `crossFreqOverhearGainDb` (default +6) - gain bump for emergencies overheard on monitored frequencies.

---

## Phasing

### Phase 1 - Concurrent positions runtime (foundation)

- Extend `controllerScopes` vocabulary (Component 1).
- Position registry migration to support `kind` (Component 2).
- Held-positions set + active TX key in Redis (Component 3).
- Updated claim / release / new activate-tx endpoint.
- `GET /v1/tower/positions/me` returns the union view.
- PositionBar concurrent variant (Component 5) — chips, switching, "+ Add position…" popover.
- Cap enforcement.
- Voice routing rebind on TX change (Component 4) — assumes per-frequency channels infra is in place.

Exit: a `controller` user with `controllerScopes: ["tower", "ground"]` claims both positions, sees two chips, can switch active TX with sub-second voice tune, both filters apply.

### Phase 2 - Range Safety seat

- Add `range-safety` scope + `rso-ksc` position.
- Range Safety Desk variant (Component 7a).
- HOLD / SCRUB / ABORT endpoints + LiveKit data messages.
- Downrange exclusion polygon storage + map overlay.
- Phase-of-flight chip detector.

Exit: a controller with `range-safety` scope claims `rso-ksc` (alongside Tower if they want), sees trajectory tape + ABORT button, fires ABORT during a test launch, every connected client sees a critical alert + the pilot's HUD shows the abort banner.

### Phase 3 - Recovery / SAR seat

- Add `recovery` scope + `recovery-ksc` position.
- Recovery Desk variant (Component 7b).
- Splashdown detection trigger.
- Drift estimate + probability ellipse on map.
- Recovery-state lifecycle + endpoint.
- SAR conversation pinned per recovery.

Exit: a vessel splashes; a controller with `recovery` scope claims `recovery-ksc`; the recovery desk shows splashdown coords + drift ellipse that grows over 5 minutes; "Mark recovered" closes the alert.

### Phase 4 - CapCom seat (per-mission dynamic positions)

- Add `capcom` scope + dynamic position creation.
- CapCom subroom auto-provision per crewed orbital vessel.
- CapCom Desk variant (Component 7c) without the life-support fields (still pre-Phase 4 of KERBALISM_TELEMETRY_PLAN).
- Annotation log + timeline integration.
- Auto-archive on landing + grace period.

Exit: pilot launches a crewed mission to orbit; a `capcom-mission-XXX` position auto-appears; controller claims it; voice subroom is private; MET clock + crew manifest visible.

### Phase 5 - Life support / health integration

Wire up the deferred Phase 4 of [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md):

- Flip `KERBALISM_LIFESUPPORT_ENABLED=true` in production.
- CapCom Desk renders life-support / habitat / crew health / storm panels.
- Recovery Desk reads life-support seconds-remaining as a soft urgency cue.

Exit: with Kerbalism installed, a CapCom seat shows live O2 / water / food countdowns + per-crew dose + storm window.

### Phase 6 - Polish + stretch

- Trajectory prediction (RSO ground-track projected forward 60 s).
- Sea state from a dedicated weather config (replaces "Calm" stub).
- Per-position keybindings for active-TX switching (e.g. F1-F4).
- Per-position notification routing (browser tab badge counts per held position).
- Scenario engine ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) §5.5) for RSO drills (scripted abort scenarios).

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| One user holding 4 positions creates "god controller" who hoards everything | Hard cap at 4 (configurable). Admin can audit per-user held-position counts in AdminDesk. Phase 6 idea: soft warning when a single user holds >2 of the airport-fixed seats. |
| Voice TX switching mid-conversation creates dropped audio | Sub-second tune from PER_FREQUENCY_CHANNELS_PLAN target; PTT release latches the previous room for 200 ms (existing release hangover from VOICE_RELIABILITY_PLAN) so a fast switch doesn't truncate the last syllable. |
| Active TX accidentally switches via stray click | Position chips have a 200 ms "click-to-confirm" debounce when switching; double-click to switch within debounce window for power users. |
| Concurrent positions confuse handoff (who's actually doing tower right now?) | PositionBar shows active TX prominently; the strip card shows "owned by USER (TWR)" with the seat in parens. Audit log records every TX switch + every position claim/release. |
| Scope sprawl in `ControllerScope` union | New scopes require admin grant; runtime enforcement is a single helper `userHasScope(user, scope)`. The union string is just a label; no new authorization surface. |
| CapCom dynamic positions accumulate forever | Auto-archive 5 min after landing AND unclaimed. Cron sweep nightly to purge orphans (vessel deleted but position never archived). |
| Recovery drift ellipse misleads when sea currents are unknown | Doc'd in tooltip: "Estimate based on last-known surface velocity, decayed 50% per minute. Real currents not modeled." Grows visibly to set expectations. |
| RSO ABORT button hit by mistake | 3-second confirm-tap, free-text reason field (env-flagged). Action is loud but reversible — the alert can be resolved + scrubbed if it was an error. |
| User with `all` scope unintentionally inherits `range-safety` | `all` explicitly maps to `[tower, ground, approach, range-safety, recovery, capcom]` — documented. Admins managing legacy `all`-scope users get an upgrade-prompt UI in Phase 1: "this user previously had `all`, which now also includes RSO/Recovery/CapCom — keep or restrict?" |
| Multi-position user fails to notice an alert on a non-active position | Alert chip on PositionBar lights red + chime; AlertsBanner pins critical regardless of position. |
| LiveKit room count grows linearly with crewed missions (CapCom subrooms) | Each mission = one subroom; subrooms close on archive. Document a hard cap (`MAX_ACTIVE_CAPCOM_SUBROOMS`, default 50) and revisit pricing once the feature lands. |
| Per-position keybinding conflicts with KSP keybindings (Phase 6) | Default keybindings only on the web; plugin keybindings opt-in via TowerModSettings. |

---

## Test plan

- **Concurrent claim:** User with scopes `["tower", "range-safety"]` claims tower-ksc, then rso-ksc. PositionBar shows both chips. Active TX defaults to most recently claimed (rso-ksc). Voice publishes only on rso frequency. Both filters apply.
- **TX switch latency:** Click tower chip → active TX flips, voice publish moves to tower freq within 1 s.
- **Cap enforcement:** With cap 2, attempt to claim a third position → 409 with explanatory body.
- **Auto-promote on release:** Hold 3 positions, release the active TX → server promotes the next-most-recent.
- **Cross-frequency emergency overhear:** Mayday fires on a monitored (non-active) frequency → chip turns red, audio gain +6 dB, banner appears.
- **RSO abort flow:** Claim rso-ksc, click ABORT, 3-s confirm hold → critical alert with `source: "rso-abort"` lands on every controller; pilot HUD shows the abort banner; pilot's `ActionGroup.Abort` is NOT auto-fired.
- **Recovery splashdown:** Vessel splashes → recovery alert auto-fires; recovery-ksc desk shows splashdown coords; drift ellipse grows over 5 min; "Mark recovered" closes alert.
- **CapCom dynamic position:** Pilot achieves orbit with crew → `capcom-mission-XXX` appears in "+ Add position…" popover for any user with `capcom` scope, filtered to the right world. Two CapCom claim attempts → second 409s.
- **CapCom auto-archive:** Vessel lands, position unclaimed for 6 min → archived from the popover.
- **Back-compat:** Existing `controller` user with `controllerScopes` undefined → still able to claim every airport-fixed position.
- **Admin scope edit:** Admin removes `range-safety` from a user mid-claim → their next claim attempt 403s; they keep their existing held position until they release it (no forced kick).
- **Voice token regrant on switch:** Server re-issues LiveKit token on every TX switch with the new publish-room set; existing room subscriptions stay alive.

---

## File touchlist

**Plans (cross-link)**

- [HANDOFF_PLAN.md](HANDOFF_PLAN.md) — note the concurrent-positions extension; defer to this plan for runtime semantics.
- [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) — note the multi-room grant model is the foundation; defer here for active-TX semantics.
- [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md) — note the `controllerScopes` array now spans more scopes; the `all` mapping changes.

**Backend (new)**

- `backend/src/services/positions.ts` — held-positions Redis set, active TX key, fanout view (extends the file from HANDOFF_PLAN; created here if HANDOFF_PLAN hasn't shipped first).
- `backend/src/services/recovery.ts` — splashdown detection, drift state, lifecycle.
- `backend/src/services/capcom.ts` — dynamic position auto-provision + auto-archive.
- `backend/src/services/rso.ts` — abort/hold/scrub command dispatch + downrange polygon CRUD.

**Backend (edits)**

- [backend/src/services/webAuth.ts](backend/src/services/webAuth.ts) — extend `ControllerScope` union; helper `userHasScope`.
- [backend/data/positions.json](backend/data/positions.json) — add rso-ksc, recovery-ksc.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) — mount activate-tx, abort/hold/scrub, recovery, capcom routes.
- [backend/src/services/alerts.ts](backend/src/services/alerts.ts) (from KERBALISM_TELEMETRY_PLAN or COMMS_SAFETY_PLAN) — add `rso-abort`, `splashdown`, `lost-craft` source types.

**Web (new)**

- `web/src/pages/RangeSafetyDesk.tsx` (or scope-variant of TowerDesk per Component 7).
- `web/src/pages/RecoveryDesk.tsx` (likewise).
- `web/src/pages/CapcomDesk.tsx` (likewise).
- `web/src/components/PositionBar.tsx` — concurrent variant (extends or replaces the HANDOFF_PLAN PositionBar).
- `web/src/hooks/useHeldPositions.ts` — wraps `GET /v1/tower/positions/me`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) — accept `scope` prop; render the scope-appropriate workflow column.
- [web/src/pages/AdminDesk.tsx](web/src/pages/AdminDesk.tsx) — multi-select chips for new scopes; `all`-upgrade prompt for legacy users.

**Plugin (edits)**

- [PluginSrc/TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs) — handle TX-position-changed metadata to flip publish room.
- [PluginSrc/TowerCountdownState.cs](PluginSrc/TowerCountdownState.cs) — accept HOLD / SCRUB commands from RSO.
- [PluginSrc/TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) — render RSO ABORT banner on the radio panel when received.

**Docs (edits)**

- [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) — sections 4.4 / 4.5 / 4.6 cross-link this plan.
- [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) — §6 (handoff) notes the concurrent-positions extension; §10 (frontend IA) notes the seat-variant pattern.
