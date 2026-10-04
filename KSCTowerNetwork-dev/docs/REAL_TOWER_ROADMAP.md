# KSC Tower Network - Real Tower Roadmap

> **Cross-cutting design constraint:** Every roadmap item below operates inside the world+time model laid out in [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). Each player runs their own KSP instance, with their own planet pack (stock Kerbin / RSS Earth / JNSQ / etc.) and their own in-game UT clock. Per-airport state (runways, frequencies, positions, NOTAMs, ATIS) is `(worldId, airportId)`-scoped; per-player state (callsign, squawk, weight class) is world-agnostic; alerts use server wall-clock; ATIS broadcasts use the subject airport's local UT. The marker-click panel reveals each subject's local context (their airfield, their UT, their day/night state) regardless of the viewer's world.

## Purpose

This document defines what is missing between the current prototype and a realistic, operational tower experience for multiplayer KSP operations. It is intentionally practical: each section describes user-facing behavior, backend/data requirements, and suggested implementation order.

Current state is a functional prototype with chat, telemetry ingestion, initial voice plumbing, and a basic tower desk. Target state is a stable, role-driven ATC workflow with situational awareness and operational controls.

---

## Product Goals

- Deliver a believable tower workflow for KSC operations.
- Keep local development simple while preserving production-safe architecture.
- Prioritize reliability first (audio, telemetry integrity, session ownership), then realism features.
- Support multiple simultaneous aircraft with clear controller ownership and conflict visibility.
- Preserve auditability (what was said, what was cleared, what happened).

---

## Definitions

- **Pilot**: KSP client publishing telemetry and receiving tower instructions.
- **Tower controller**: User issuing clearances and sequencing traffic.
- **Supervisor/Admin**: Elevated role for monitoring, intervention, handoff, moderation.
- **Strip**: A live operational card for one aircraft/session.
- **Ops timeline**: Time-ordered stream of clearances, events, telemetry markers, and voice-related metadata.

---

## Gap Analysis: What Is Missing

### 1) Voice Reliability and Tower Audio UX (Critical)

**Lifted into its own implementation plan: [VOICE_RELIABILITY_PLAN.md](VOICE_RELIABILITY_PLAN.md).** Owns the Phase 0 stabilization gate. Highlights: one canonical `RoomVoiceState` reducer consumed by every surface (web + plugin + bridge), per-mic and per-remote AnalyserNode metering, three transmit modes (open/ptt/latch) with debounced PTT + 200 ms release hangover + three-state TX indicator, per-participant gain + deafen with persistence, bounded reconnect with backoff + stalled-track auto-resub + server-side janitor for zombie peers, canonical capture/receive/master audio chain (noise gate → preamp → optional Kerbalizer → publish; receive → optional Kerbalizer → squelch tail → per-participant gain → master limiter at -1 dBFS), 4-step mic test wizard, comms health diagnostics panel + diagnostic bundle export, LiveKit webhook + alerts integration via [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md).

#### Missing
- Deterministic voice state indicators (publish/subscribed/speaking/muted/reconnecting).
- Reliable local mic metering and separate incoming audio metering.
- Push-to-talk and press-to-mute workflow.
- Per-participant gain controls and quick mute/deafen actions.
- Robust reconnect and stale-participant handling.
- Audio safety controls (noise gate/squelch, output limiter, anti-feedback behavior).

#### Why it matters
Tower operations fail immediately if comms are unreliable, ambiguous, or dangerously loud/feedback-prone.

#### Deliverables
- Voice status model in backend + frontend (explicit connection + track state).
- Participant audio controls panel.
- Mic test wizard (device select, input sensitivity, level check).
- “Comms health” diagnostics panel (latency, packet loss proxy, track state).

---

### 2) Multi-Aircraft Situational Awareness Map (Critical)

#### Missing
- Single-vessel prototype map only.
- No “everyone in room” plotting.
- No runway overlays, no approach paths, no KSC zones/geofences.
- No traffic history trails or intent vectors.

#### Why it matters
Real tower work is sequencing and separation based on where all aircraft are and where they are going.

#### Deliverables
- Multi-target map from active sessions with telemetry.
- KSC geometry overlays:
  - Runway centerline(s)
  - Threshold markers
  - Final approach corridor
  - Pattern altitude hints
- Marker labels:
  - Callsign/craft name
  - Ground speed
  - Altitude
  - Heading
  - Mode/state (taxi/departure/arrival/go-around)
- Optional trails (last N points) and short-term velocity vector.

---

### 3) Flight Strips and Clearance Workflow (Critical)

#### Missing
- No structured ATC actions.
- No strip state progression.
- No explicit clearance lifecycle.

#### Why it matters
Tower realism requires formalized state transitions and clear command tracking.

#### Deliverables
- Strip panel per aircraft/session with fields:
  - Callsign
  - Aircraft type
  - Requested operation (departure/arrival/pattern)
  - Assigned runway
  - Current phase
  - Last clearance
  - Acknowledge status
- Clearance action buttons/macros:
  - Pushback approved
  - Taxi to runway
  - Hold short
  - Line up and wait
  - Cleared for takeoff
  - Continue approach
  - Cleared to land
  - Go around
- Clearance log linked to strip and timeline.

---

### 4) Runway State and Conflict Logic (High)

#### Missing
- No runway occupancy model.
- No conflict detection for same-runway overlap.
- No active runway selection logic.

#### Why it matters
Without runway protection and conflict alerts, tower decisions are unsafe and unrealistic.

#### Deliverables
- Runway occupancy state machine:
  - Free
  - Reserved
  - Occupied
  - Vacating
- Conflict alerts:
  - Simultaneous takeoff/landing conflict
  - Line-up conflict
  - Close final + occupied runway
- Wind-aware runway recommendation hook (phase 2).

---

### 5) Arrival/Departure Sequencing Tools (High)

#### Missing
- No queue prioritization by distance/time to threshold.
- No spacing assist.
- No automated next-candidate suggestions.

#### Why it matters
Tower workload rises quickly with multiple aircraft; sequencing support is core usability.

#### Deliverables
- Arrival list sorted by ETA to threshold.
- Departure queue with readiness states.
- Spacing advisories:
  - Suggested hold
  - Extend downwind
  - Continue approach
- “Next likely clearance” suggestions (advisory only).

---

### 6) Role, Ownership, and Handoff Controls (High)

#### Missing
- Weak controller ownership semantics for active aircraft.
- No formal handoff/takeover flow.
- Limited supervisor intervention controls.

#### Why it matters
In realistic operations, authority and responsibility must be explicit.

#### Deliverables
- Per-strip owner controller.
- Handoff actions:
  - Request handoff
  - Accept/reject handoff
  - Forced supervisor reassignment
- Shift-aware assignment and queueing.

---

### 7) Operational Logging and Replay (High)

#### Missing
- Events are not consolidated into one operational timeline.
- No replay for debriefing incidents.

#### Why it matters
Training, moderation, and debugging require replayable context.

#### Deliverables
- Unified timeline events:
  - Telemetry snapshots (key moments)
  - Clearances issued
  - Acknowledgements
  - Voice state events (connect/disconnect/mute)
- Filterable timeline by aircraft/session/controller.
- Exportable incident bundle for post-event review.

---

### 8) Alerting and Safety Rules (Medium-High)

#### Missing
- No robust tower safety alerts.
- No severity/acknowledge model.

#### Why it matters
Real tower software emphasizes proactive hazard awareness.

#### Deliverables
- Alert engine with severity levels:
  - Info
  - Warning
  - Critical
- Initial rule set:
  - Runway incursion risk
  - High closure on final
  - Gear-up landing risk
  - Extreme sink rate near runway
- Alert acknowledgement and ownership.

---

### 9) Data and API Expansion Needed (Foundation)

## Required backend additions

- Active sessions with telemetry endpoint for map and roster.
- Strip state and clearance resource model.
- Runway state resource model.
- Timeline events endpoint.
- Alert state endpoint.

## Example endpoint set

- `GET /v1/tower/active-aircraft`
- `GET /v1/tower/strips`
- `POST /v1/tower/strips/:id/clearance`
- `POST /v1/tower/runways/:id/state`
- `GET /v1/tower/timeline`
- `GET /v1/tower/alerts`
- `POST /v1/tower/alerts/:id/ack`

## Data model additions

- `callsign`
- `aircraftType`
- `operationIntent`
- `assignedRunway`
- `stripState`
- `clearanceHistory[]`
- `controllerOwnerUserId`
- `alertState[]`

---

### 10) Frontend IA (Information Architecture) Needed

## Tower Desk should become a multi-panel workstation

- **Map panel**: traffic, runways, zones, vectors.
- **Strips panel**: per-aircraft workflow + quick clearances.
- **Runway panel**: occupancy and locks.
- **Comms panel**: participants, levels, controls.
- **Alerts panel**: prioritized safety notices.
- **Timeline panel**: searchable operational history.

## UX requirements

- Hotkeys for high-frequency actions.
- Non-blocking toasts for low-priority events.
- Persistent critical alerts until acknowledged.
- Color semantics consistent with ATC context (safe/caution/conflict).

---

## Suggested Delivery Phases

### Phase 0 - Stabilization (Immediate)

- Finalize audio reliability and anti-freeze behavior.
- Verify telemetry freshness and consistency.
- Ensure deterministic identity/session behavior in LiveKit.
- Add health diagnostics in tower UI.

Exit criteria:
- No KSP audio freeze under 20+ minutes of live comms.
- Voice connect/disconnect recovery < 5 seconds.

### Phase 1 - Multi-Aircraft Awareness (Next)

- Backend endpoint for active aircraft telemetry.
- Multi-aircraft map markers + trails.
- Basic roster list synced with map.

Exit criteria:
- 3+ concurrent aircraft visible and updating in near-real time.

### Phase 2 - Strips + Clearances

- Strip model and UI.
- Clearance action flow.
- Clearance log and acknowledgement states.

Exit criteria:
- Full departure and arrival workflow executable from UI.

### Phase 3 - Runway Logic + Sequencing

- Runway occupancy state.
- Conflict detector.
- Arrival/departure queue assistant.

Exit criteria:
- Conflict alerts fire correctly in test scenarios.

### Phase 4 - Alerts + Timeline + Handoff

- Unified event timeline.
- Alert acknowledgement system.
- Controller handoff workflow.

Exit criteria:
- Supervisor can reconstruct and manage live operations reliably.

### Phase 5 - Quality and Training Features

- Phraseology macro library.
- Scenario/training mode.
- Post-session replay tooling.

---

## Test Plan Themes

- **Comms tests**
  - Mic capture verification
  - Reconnect and mute/unmute races
  - Long-run stability
- **Map/telemetry tests**
  - Coordinate correctness
  - Multi-client update cadence
  - Outlier handling
- **Workflow tests**
  - Strip transitions
  - Clearance ack path
  - Handoff edge cases
- **Safety tests**
  - Conflict detector false positive/negative rates
  - Alert dedupe and escalation correctness

---

## Spectator vs active role (TODO — currently `/tower` requires an active session)

`/tower` and `/tower/wall` are now gated on the SPA-shell `activeRoomOnly` guard, which reads server-truth from `GET /v1/me/active-room`. A user only "has an active room" when they are the pilot or assigned controller of an open session — anyone else hitting `/tower` is bounced to `/lobby`. The lobby's per-room "Open" button is hidden for rooms the caller doesn't own; it's replaced with a disabled "Spectate (soon)" affordance so the missing capability is obvious.

The previous behavior (any signed-in member could land on `/tower`, the SPA fell back to the `dev-shared` bootstrap session, and per-action backend 403s decided what was actually allowed) is gone. The route guard plus the "open only your own room" lobby button is a stricter MVP, but it eliminated three real footguns the user complained about:

- The topbar showed a stale `SESSION` pill from `localStorage` even when the user wasn't in any room.
- `/tower` mounted on `dev-shared` and "looked working" while telemetry / chat / voice were targeting a permanently-empty bootstrap session.
- Voice's status pill said "Connected" because LiveKit *was* connected — to `tower-dev-shared`, an empty room with no peers. Users believed they could talk and couldn't.

What we still want eventually (proper spectator role):

- A first-class `spectator` role distinct from `controller` and `pilot`.
- A real backend join: `POST /v1/session/:id/spectate` (or similar) that adds the user to the session's roster as a listener, so `GET /v1/me/active-room` can return the spectated room with `myRole: "spectator"`.
- Read-only by default: map, telemetry, ACARS / voice receive, chat send.
- Hide (don't just disable) every "act on the session" affordance for spectators: assume controller, rotate next tower, block user, edit checklist, set countdown, edit squawk / callsign, push world / terrain / video frames, mod tools.
- Voice: spectators connect as listeners only (LiveKit `canPublish=false` on the token), no PTT button, no mic device selection.
- Lobby: replace the disabled "Spectate (soon)" button with a working one that calls the spectate endpoint, sets storage, navigates to `/tower`, and the topbar pill flips to "SPECTATING <name>" with a Leave button that hits the inverse endpoint.
- Backend: keep the existing pilot / controller authorization on the endpoints (defense in depth) and also stamp the issued capability set on `/v1/auth/me` so the SPA can render the right shape without trial-and-error.

Until that lands, the rule is simple: you must own (or be assigned to) a room to use the Tower workspace.

---

## Risks and Mitigations

- **Risk: Audio regressions in KSP plugin**
  - Mitigation: bounded queue, squelch, runtime metrics, stress tests before feature growth.
- **Risk: Session identity confusion across web/plugin/bridge**
  - Mitigation: explicit identity policies and central validation.
- **Risk: UI overload for controllers**
  - Mitigation: phased rollout and compact default panels with progressive disclosure.
- **Risk: Alert fatigue**
  - Mitigation: strict severity model and suppression/dedupe rules.

---

## Definition of “Real Tower MVP”

A “real tower MVP” is complete when all are true:

- Voice is stable and operationally usable.
- Tower sees all active aircraft near KSC on a shared map.
- Controller can issue and track structured clearances via strips.
- Runway occupancy/conflict visibility exists.
- Core operations are logged in a searchable timeline.

At that point the system supports believable, repeatable ATC operations instead of ad-hoc chat + telemetry monitoring.

