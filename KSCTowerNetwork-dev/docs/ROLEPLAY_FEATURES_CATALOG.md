# Role-Play Features Catalog

> **Cross-cutting design constraint:** Every feature here lives inside the world+time model laid out in [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). Per-airport state (runways, frequencies, positions, NOTAMs, ATIS) is `(worldId, airportId)`-scoped so stock Kerbin KSC and RSS Earth KSC are distinct airfields. Per-player state (callsign, squawk, weight class, alerts) is world-agnostic. In-game time-of-day is per-player (`subjectUt`), wall-clock time (alerts, NOTAM windows, recordings) is server-time. Read that doc once before working on any plan below.

## Purpose

Catalog of immersion / role-play features that extend KSCTowerNetwork beyond pure ATC mechanics. Each entry is sized as "what to build, where it slots into the existing code, why it matters." Scoped intentionally above the level of a TODO list and below the level of an implementation plan; lift any item out of here into its own doc when it's ready to be built.

This is a *companion* to:

- [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) - the authoritative ATC mechanics roadmap.
- [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) - in-game ghost traffic + tower hull-cam.
- [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md) - aggregate telemetry surface.
- [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md) - voice + Kerbalizer.

Many items here are *prerequisites* or *force-multipliers* for items in those plans (especially handoff in roadmap section 6 and the alert engine in section 8).

---

## Recommended near-term trio

If you want maximum role-play return on minimum new code, ship these three first - they are cheap individually, compound enormously together, and unblock follow-on work in the other plans:

2. **Squawk codes + callsign registry** - tiny data fields, big identity payoff, hooks into every existing panel.
3. **Per-frequency channels (Ground / Tower)** - unlocks the multi-controller fantasy and is a prerequisite for everything in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 6 (handoff).

---

## 1. Comms & phraseology (extends voice + chat)



### 1.2 ATIS broadcast loop

Auto-generated `"Kerbin Space Center Information Alpha. Time 1342 Zulu. Wind 270 at 8. Active runway 09. Altimeter 29.92..."` looping on the voice bridge.

**Lifted into its own implementation plan: [ATIS_PLAN.md](ATIS_PLAN.md).** Highlights: local Piper TTS (intentionally robotic, like real D-ATIS), per-user mute on the main room until per-frequency channels (1.3) ship, NATO-letter advancement on material wind/runway/NOTAM change with hysteresis + debounce.

### 1.3 Per-frequency channels

Ground / Tower / Approach / CTAF / Guard / ATIS. Replaces the current one-room-per-session model with persistent frequency rooms; each user has one primary (transmit) and N monitors (listen-only).

**Lifted into its own implementation plan: [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md).** Highlights: declarative `frequencies.json` config, `issueLiveKitToken` extended to multi-room grants, Redis-backed tuning state, sub-second tune knob feel, ATIS frequency move folded in, prereq for handoff (roadmap section 6) and the multi-role expansion in section 4 below.

### 1.3a Controller / mod move-user ("contact Tower 118.5")

Tower controllers and moderators can re-tune other users' **voice frequency** — the realistic "contact KSC Ground 121.7" handoff for controllers, and the "get this griefer off Guard" tool for mods.

> Scope reminder (see [GLOSSARY.md](docs/GLOSSARY.md) "Room"): this feature only moves a user between **frequency voice rooms** (`freq-*`). It does *not* eject them from their **tower session** (the lobby "room" that owns telemetry, hull-cam, chat, strip, and squawk). Their session is untouched; only their primary radio frequency changes.

**Lifted into [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) section 6** since it shares the tune state machine, token reissue, and Redis key with self-tuning. Highlights: two modes — `suggest` (controller, pilot acknowledges with **Tune** / **Decline**, auto-applies after 8 s) and `force` (mod+, immediate, non-dismissable banner). Push delivered via LiveKit data message on Guard with SSE fallback. Self-tune always wins over a forced move (mods enforce, don't pin). Per-actor rate limits + abuse alerting on force-tune storms. Audit entry on every push for the operational timeline ([REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 7).

**Dual-name + nav-code path:** the same plan extends the frequency schema with a short English `shortName` (e.g. `stock2`, `RSS-twr`, `guard`) and a globally-unique 3-or-4-digit `navCode` (e.g. `185`). The number is the lingua franca: a controller types just `185` in the room chat and the chat parser converts it into a suggested tune-push to every pilot they're talking to; a pilot punches `185` into the in-game radio's nav keypad and self-tunes. Squawk codes (`7700` / `7600` / `7500` / `1200`) are reserved and never assignable as nav codes.

### 1.4 Squelch / static tail

Short burst of pink noise + "kerchunk" on PTT release. Sells the radio feel.

**Lifted into its own implementation plan: [SQUELCH_TAIL_PLAN.md](SQUELCH_TAIL_PLAN.md).** Highlights: per-listener Web Audio synthesis chained after the Kerbalizer, parallel C# implementation in [TowerVoicePlayback.cs](PluginSrc/TowerVoicePlayback.cs) for in-game playback, ATIS bot identity-suppressed, on-by-default with user toggles.

### 1.5 Stuck mic detector

Participant transmitting >15 s -> tower override option. Mods can always mute anyone.

**Combined with 1.6 into one implementation plan: [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md)** - they share the alert event shape, voice metadata dispatch, and recording capture pipeline. Highlights here: client-side detector with one banner per stuck transmission, one-click `force-mute` LiveKit data message honored by web *and* by [TowerVoiceBridgeControl.cs](PluginSrc/TowerVoiceBridgeControl.cs).

### 1.6 Mayday / Pan-Pan button

Pilot-side emergency declaration.

**Combined with 1.5 into one implementation plan: [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md).** Highlights: confirm-tap MAYDAY / PAN-PAN buttons on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) (mirrored on web), critical-severity alert event, auto-7700 squawk via [IDENTITY_PLAN.md](IDENTITY_PLAN.md), strip freeze, 60-second LiveKit egress capture attached to the alert.

---

## 2. Pilot-side immersion (KSP plugin)

### 2.1 Kneeboard / EFB overlay

In-flight panel showing current clearance, assigned runway, frequency list, weather, last instruction.

- New `[KSPAddon(Flight, false)]` MonoBehaviour modeled on [TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) (same IMGUI patterns + draggable Rect).
- Data source: existing telemetry response + the new fields added by the strips/clearance work in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 3.
- Toolbar entry on [TowerToolbar.cs](PluginSrc/TowerToolbar.cs).

### 2.2 Checklist runner with voice-call response

Extends [ChecklistPanel.tsx](web/src/session/ChecklistPanel.tsx) and the in-game equivalent used by [TowerCountdownHud.cs](PluginSrc/TowerCountdownHud.cs).

- Phase 1: pure hotkey "challenge / response" advancement.
- Phase 2: PTT keyword spotting ("flaps set", "gear down") via a small on-device speech recognizer; advances the checklist on match.
- Phase 3: optional copilot TTS readback via a per-pilot side-channel.

### 2.3 Squawk code

Assignable transponder code per session, with emergency code semantics (7700 / 7600 / 7500 / 1200).

**Combined with 6.1 into one implementation plan: [IDENTITY_PLAN.md](IDENTITY_PLAN.md)** (they ship together since both touch the same surfaces). Data layer mostly already exists in [repository.ts](backend/src/services/repository.ts) - this plan focuses on tower-mutable squawk endpoint, emergency-code side effects, and surfacing to plugin via telemetry response.

### 2.4 Fuel / souls-on-board reporting

Quick "fuel remaining 00:42, souls 5" RP card the tower can request.

**Lifted into its own implementation plan: [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md).** Highlights: stock-derived `fuelSecondsRemaining` + `ecSecondsRemaining` (no Kerbalism dependency, ships in Phase 2), bundled with the Kerbalism failure-event plumbing and the deferred life-support / habitat / crew-health / storm telemetry that the mission-ops seats consume. Tower button on the strip = "request POB/fuel/EC"; pilot's plugin auto-replies with the next telemetry tick + a chat message.

### 2.5 Aircraft type / weight class chip

Light / Medium / Heavy / Super derived from `wetMass` (already in telemetry).

**Lifted into its own implementation plan: [WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md).** Highlights: pure backend classifier captured once on first valid flight frame, tower override with inset-border styling, chip rendered on all eight existing callsign surfaces, "Heavy" suffix in voice transcripts, named field `effectiveWeightClass` reserved for the sequencer in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 5.

---

## 3. Tower-side role-play tools

### 3.1 Wind sock / METAR card

Compact text card on the Tower Desk: `KKSC 171340Z 27008KT 10SM CLR 15/M02 A2992`.

- Backend: METAR generator service. Phase 1 is hardcoded; phase 2 reads a configurable wind setting; phase 3 reads stock KSP weather from the active session if available.
- Web: small panel pinned to the Tower Desk header.
- Feeds the ATIS loop (1.2) and the macro pad (1.1).

### 3.2 Runway light controls

Toggle HIRL / approach lights / PAPI state.

- Web Phase 1: cosmetic toggles that update tower UI only.
- Web Phase 2: pushed via session metadata to all pilots' UIs (kneeboard shows "PAPI: on").
- Plugin Phase 3 (optional): physically toggle light prefabs near the runway via a small `[KSPAddon(Flight, false)]` driver. Out of scope unless mod stack already touches scene lighting.

### 3.3 Progressive taxi instructions

Clickable taxiway map: "taxi via A, B, hold short 09."

- Web: route picker overlay on the existing Kerbin map; click a sequence of waypoints.
- Posts as a structured clearance into the future strip model.
- Pilot plugin: kneeboard (2.1) draws the route on its mini-map.

### 3.4 Hold short / line-up-and-wait visual locks

Color the runway threshold red/amber/green on both desks before the full conflict engine arrives.

**Lifted into its own implementation plan: [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md).** Highlights: declarative `runways.json`, manual state model with auto-`occupied` from telemetry, map overlay in addition to the panel, becomes the input data for the conflict engine in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 4 when that lands.

### 3.5 "Say again" / readback request

One-click chat ping + short TTS to the assigned pilot.

- Tower UI button on each strip.
- TTS plays only on that pilot's voice client (LiveKit data message + local synth).
- Logged.

### 3.6 Shift log / position relief briefing

When a controller hands off (roadmap section 6), auto-generate a summary: active runway, traffic in pattern, current ATIS letter, open strips, outstanding alerts.

**Lifted into its own implementation plan: [HANDOFF_PLAN.md](HANDOFF_PLAN.md).** Highlights: declarative `positions.json` (position = frequency + strip filter), Redis-backed ownership with handoff lifecycle (request / ack / reject / cancel / expire), snapshot brief frozen at request time pulling from frequencies / runway locks / ATIS / alerts / strips, position bar on the Tower Desk, manual-first foundation for the formal handoff in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 6.

---

## 4. Multi-role expansion (new seats at the desk)

All of these depend on per-frequency channels (1.3) and tower-scoped active-aircraft (the endpoint introduced in [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) Phase 1).

**4.4 / 4.5 / 4.6 are lifted as a single multi-seat pack into [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md)** with one important twist on top of [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md)'s `controllerScopes`: a single tower controller can hold *multiple* of these positions concurrently (Tower + RSO + CapCom at the same time), not just swap between them. Active-TX position selector drives voice routing; alert/strip filters are the union of held positions. Each seat-specific section below cross-links the same plan.

### 4.1 Ground controller seat

Owns taxi clearances and pushback, separate from Tower.

**Lifted into its own implementation plan: [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md).** Highlights: `controllerScopes` sub-capability on the existing `controller` role, declarative `requiredScope` per position, server-side `stripPhase` detector + `stripFilters` (ground-domain / air-domain / boundary window), per-transition write-scope enforcement on `runwayLocks`, scope-aware variant of TowerDesk with auto-tuned Ground frequency. First real exercise of [HANDOFF_PLAN.md](HANDOFF_PLAN.md) + [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) + [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) together.

### 4.2 Approach / Departure seat

Owns aircraft >5 km out; hands off to Tower at the FAF.

- Strip ownership transfers automatically based on distance to threshold + altitude.
- Approach frequency.

### 4.3 Flight Service / Clearance Delivery

IFR-style clearance copy ("cleared to KKSC2, climb maintain FL120, squawk 4521") before pushback.

- Macro pad (1.1) generates the clearance string from a JSON IFR template.
- Pilot reads back via voice or a one-click "wilco" button.
- Issues squawk (3.3) automatically.

### 4.4 Range Safety Officer

For rocket ops. Different fantasy, same infrastructure.

**Covered by [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) Phase 2.** Highlights: dedicated Range Safety Desk variant (trajectory tape, downrange distance, exclusion-zone polygon editor on the map), HOLD / SCRUB / ABORT buttons (ABORT is a critical alert + LiveKit data message, not an auto-fired `ActionGroup.Abort`), phase-of-flight chip (PRE-LAUNCH → LIFTOFF → MAX-Q → ORBIT-INSERTION). HOLD / SCRUB tie into [TowerCountdownState.cs](PluginSrc/TowerCountdownState.cs).

### 4.5 Recovery / SAR coordinator

Once a vessel splashes down, switches to recovery mode.

**Covered by [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) Phase 3.** Highlights: splashdown auto-trigger off the existing `situation` field, drift-estimate ellipse on the map (last-known surface velocity, configurable per-minute decay), recovery-state lifecycle (SPLASHED → DRIFTING → RECOVERED → LOST), pinned SAR coordination chat with auto-prefilled splashdown coords + crew manifest.

### 4.6 CapCom (mission control)

Single-pilot voice channel with mission elapsed time overlay.

**Covered by [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) Phase 4.** Highlights: per-mission *dynamic* position (auto-provisioned when a crewed vessel reaches orbit, auto-archived 5 min after landing — not a fixed entry in `positions.json`), private LiveKit subroom per mission, MET clock from `universalTime`, crew manifest with per-crew dose + stress chips when [KERBALISM_TELEMETRY_PLAN.md](KERBALISM_TELEMETRY_PLAN.md) Phase 4 is enabled, annotation log piped to the timeline. Concurrent-positions model means one user can be CapCom for multiple missions at once (subject to the per-user position cap).

---

## 5. Procedure / scoring loops (extends Scorecard)

### 5.1 Approach plate viewer

Pre-canned IAPs for KSC runways (ILS 09, RNAV 27, visual 09).

- Phase 1: just images + minimums on the EFB (2.1).
- Phase 2: live aircraft position overlaid on the plate.
- Authoring builds on `web/scripts/gen_kerbin_navaids.py`.

### 5.2 Departure procedures (SIDs)

"KSC ONE departure: runway heading to 3000 ft, then direct DESSY."

- Tower assigns from a SID library; pilot flies; existing [Scorecard.tsx](web/src/session/Scorecard.tsx) verifies waypoint hits.

### 5.3 Pattern work scoring

Closed-traffic mode that auto-scores downwind altitude, base turn distance, threshold crossing height.

**Lifted into its own implementation plan: [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md).** Highlights: server-side leg detector (`upwind|crosswind|downwind|base|final|touchdown|rollout|go-around`) with 3-frame hysteresis, per-circuit metrics (downwind altitude/offset, base turn distance, final intercept Δ, CTH, touchdown distance + sink + offset), Scorecard tab with color-coded per-circuit rows + mini-map track overlay, runway pattern config extends [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s `runways.json`, persisted shape feeds 5.4 leaderboard.

### 5.4 Spot-landing competition mode

Weekly leaderboard of CTH + touchdown distance from threshold + sink rate.

- All metrics already derivable from existing telemetry.
- Backend: leaderboard table + weekly reset cron.
- Web: leaderboard route, link from lobby.

### 5.5 Training scenarios

Scripted JSON: "engine failure on takeoff", "go-around for runway incursion", "thunderstorm avoidance."

- Tower runs from [AdminDesk.tsx](web/src/pages/AdminDesk.tsx).
- Scenario engine pushes timed events (alerts, weather changes, fake traffic ghosts) into the room.
- Reuses ghost fleet from [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) for scripted "intruder" aircraft.

---

## 6. "Sells the world" cosmetics

### 6.1 Custom callsign registry

Replace `Kerbal-1234` with `Bobcat 7` / `Jeb Air 101`.

**Combined with 2.3 into one implementation plan: [IDENTITY_PLAN.md](IDENTITY_PLAN.md).** Per-account (not per-session) callsign with regex validation, case-insensitive uniqueness, reserved-prefix denylist (cross-coordinated with `KSC-TOWER-*` from [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md)), and a sweep of every UI surface that currently shows raw session ids.

### 6.2 Airline / agency liveries

Pilot picks an org (KerbalAir, Munflyer, KSC Test Wing).

- Drives marker icon on the map, callsign prefix, kneeboard logo.
- Static asset bundle in `web/public/`.

### 6.3 Time-of-day / date sync

Kerbin time on every desk header.

- Single hook reads `universalTime` from the latest telemetry frame; format as Kerbin-day clock.
- ATIS letter cycles (1.2) align with this clock.

### 6.4 Tower webcam (cosmetic)

Already covered as the *primary* deliverable in [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md). Cross-referenced here for completeness.

### 6.5 NOTAM board

Admin posts a NOTAM ("Runway 27 closed for maintenance until 1500Z").

**Lifted into its own implementation plan: [NOTAM_PLAN.md](NOTAM_PLAN.md).** Highlights: free-text body ≤500 chars with structured `severity` (info/caution/closure), `affectedRunwayIds`, `affectedFrequencyIds`, time-windowed (max 30 days), 30 s polling cache, ATIS-friendly formatter feeding [ATIS_PLAN.md](ATIS_PLAN.md) via the same debounce, closure NOTAM blocks `cleared` runway state in [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) and adds map hatching, dismissible global closure banner.

---

## Suggested phasing summary

| Phase | Items | Why grouped |
|------|------|-------------|
| A | 1.1, 1.2, 1.4 | "Sounds like ATC" - the first thing visitors will notice |
| B | 2.3, 2.5, 6.1, 6.3 | Identity + classification fields plumbed through every existing panel |
| C | 1.3 | Per-frequency channels, prereq for everything in D |
| D | 4.1, 4.2, 4.3 | Multi-role seats |
| E | 1.5, 1.6, 3.4 | Safety / emergency surfaces - feeds the future alert engine |
| F | 2.1, 2.2, 3.1, 3.2, 3.3 | Pilot kneeboard + tower convenience |
| G | 5.* | Scoring loops once everything else is stable |
| H | 4.4, 4.5, 4.6 | Range Safety / Recovery / CapCom - new fantasies on top |
| I | 6.5, 6.2, 5.5 | Cosmetic + training polish |

Phases A-C are the "near-term trio" called out at the top.

---

## Cross-cutting risks

- **Voice processing CPU**: each new DSP stage in [KerbalizerControls.tsx](web/src/audio/KerbalizerControls.tsx) (1.4 squelch, ATIS Kerbalizer) compounds. Profile after stacking 1.1+1.2+1.4 to make sure low-end clients still cope.
- **TTS cost**: ATIS regenerates on every change; debounce to one render per minute *minimum* and cache by `(letter, hash-of-broadcast)`.
- **Subroom sprawl**: per-frequency channels (1.3) plus CapCom (4.6) plus tower view streams can multiply LiveKit room counts. Document a hard cap and revisit pricing once features land.
- **Role inflation**: each new role (4.1-4.6) needs to be added to the role list in [backend/src/services/webAuth.ts](backend/src/services/webAuth.ts) and to every authorization check; centralize role-checking in one helper before adding more than one.
- **Feature toggle hygiene**: every item here adds a setting on [TowerModSettings.cs](PluginSrc/TowerModSettings.cs) or backend env; group them into named feature flags rather than booleans-per-feature so admins can enable a "comms pack" or a "scoring pack" wholesale.
