# Runway Locks - Hold Short / Line Up / Cleared - Plan

> **World scoping:** This feature is `(worldId, airportId)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). The `runways.json` config splits per world (stock Kerbin KSC, RSS Earth KSC, JNSQ KSC, etc. are distinct airfields with distinct lock state); Redis keys and API paths carry both ids; cross-world players see their own world's locks independently.

## Purpose

Manual, tower-controlled visual lock states on each runway: free / hold-short / line-up-and-wait / cleared / occupied. Renders consistently on the Tower Desk map, the pilot kneeboard, and (eventually) the in-game runway lighting. Ships before the full conflict-detection engine in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 4 - this is the *manual* version of that, and becomes the input data once the conflict engine arrives.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 3.4.

---

## Design intent

The state machine in roadmap section 4 (free / reserved / occupied / vacating) is the *automated* end state. Most of the realism payoff lands much earlier with the manual version: a controller clicks one of three buttons per runway, and that color shows up everywhere.

Three primary states, mapped to traffic-light colors that pilots already understand:

| State | Color | Meaning | Who can transmit |
|-------|-------|---------|------------------|
| `free` | green | Runway open | n/a |
| `hold-short` | red | Hold short, do not enter | tower says so |
| `line-up` | amber | Cleared to line up and wait | tower says so |
| `cleared` | green-pulsing | Cleared for takeoff or landing | tower says so |
| `occupied` | red-pulsing | Aircraft on runway | auto, set by telemetry |

`occupied` is the only auto-set state in v1 (derived from any active vessel within a runway's bounding box and below 100 ft AGL). The other four are pure manual control.

Cross-references: [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) (entry); [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 3 (strips) + 4 (runway state) + 8 (alerts); [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md) (telemetry input for `occupied`).

---

## Non-goals

- No conflict detection in v1. Two cleared aircraft on the same runway is the controller's problem.
- No wake-turbulence timer.
- No automated state transitions other than `occupied` from telemetry.
- Not a replacement for roadmap section 4; it's the foundation it'll build on.

---

## Components

### 1. Runway registry (backend)

Declarative `backend/data/runways.json`:

```json
[
  {
    "id": "ksc-09",
    "display": "RWY 09",
    "body": "Kerbin",
    "thresholdLat": -0.0486,
    "thresholdLon": -74.7245,
    "headingDeg": 90,
    "lengthM": 2500,
    "widthM": 60
  },
  {
    "id": "ksc-27",
    "display": "RWY 27",
    "body": "Kerbin",
    "thresholdLat": -0.0486,
    "thresholdLon": -74.7032,
    "headingDeg": 270,
    "lengthM": 2500,
    "widthM": 60
  }
]
```

Threshold coordinates lifted from `web/scripts/gen_kerbin_navaids.py` outputs where available.

New service `backend/src/services/runways.ts` loads, validates, exposes `listRunways()`, `runwayBoundingBox(id)`, `pointInRunway(id, lat, lon, alt)`.

### 2. Runway lock state (backend)

In-memory state per runway id, mirrored into Redis for restart resilience:

```ts
{
  runwayId,
  state: "free" | "hold-short" | "line-up" | "cleared" | "occupied",
  lockedByUserId: string | null,
  lockedAtMs: number | null,
  assignedSessionId: string | null,    // who the clearance is for
  note: string | null                  // free-text "behind departing 737"
}
```

`occupied` is derived, not stored - computed on read by the runway-occupancy detector (see 4 below). When a runway is auto-occupied, it overrides the manual state in the API response with `state: "occupied"` and `manualState: "cleared"` (etc.) so the controller still sees what they intended.

### 3. API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/v1/tower/runways` | any authed | List runways + current state. |
| `GET` | `/v1/tower/runways/:id` | any authed | One runway, including who locked it and when. |
| `POST` | `/v1/tower/runways/:id/state` | tower role | Body `{ state, assignedSessionId?, note? }`. |
| `POST` | `/v1/tower/runways/:id/clear` | tower role | Convenience: sets `state: "free"`, clears assignment. |

All in [backend/src/routes/api.ts](backend/src/routes/api.ts).

### 4. Auto-`occupied` detector

A small ticker (every 5 s) walks the active-aircraft list (from [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) Phase 1's `/tower/active-aircraft`) and, for each runway:

- If any vessel is within the runway's bounding box and `radarAlt < 30 m` -> mark as occupied.
- Set the `lastOccupancyChange` timestamp.
- Auto-clear (back to manual state) when no vessel meets the criteria for >5 s.

Lives in `backend/src/services/runwayOccupancy.ts`. Cheap; runs on the same tick cadence as ATIS.

### 5. Web UI

**Tower Desk runway panel** (new component `web/src/components/RunwayPanel.tsx`):

```
┌─ Runways ──────────────────────────────────┐
│ RWY 09  [FREE]  [HOLD] [LINE-UP] [CLEAR]   │
│         BOBCAT 7 (cleared 14:32 ago: 0:12) │
│                                            │
│ RWY 27  [FREE]  [HOLD] [LINE-UP] [CLEAR]   │
│         (free)                             │
└────────────────────────────────────────────┘
```

- One row per runway.
- Current state shown as a colored chip on the left.
- Three action buttons; clicking "CLEAR" prompts for which session to assign (auto-fills with the strip currently selected).
- Live timer since lock change.

**Map overlay** on the tower map in [TowerDesk.tsx](web/src/pages/TowerDesk.tsx):

- Runway centerline highlighted in the state color.
- Threshold rendered as a thick bar in the state color.
- Pulse animation for `cleared` and `occupied`.

**Pilot kneeboard mirror** (catalog 2.1 - kneeboard, deferred): when the kneeboard ships, it pulls runway state for the runway it's assigned to and shows the same colored chip.

### 6. Plugin (deferred to Phase 4 below)

The roadmap mentions optionally pushing runway light state to actual KSP runway prefabs. Out of scope for v1 of *this* feature; cross-referenced as a future hook in catalog 3.2.

---

## Phasing

### Phase 1 - Registry + manual state

- `runways.json`, `runways.ts`, runway state Redis store.
- `GET /tower/runways`, `POST /tower/runways/:id/state`.
- Tower Desk runway panel with colored chips + 3 action buttons.

Exit: tower can flip `RWY 09` to `hold-short`, page refresh keeps the state, second tower client sees the same state.

### Phase 2 - Map overlay

- Runway centerline + threshold rendered on the existing tower map in the state color.
- Pulse animation for `cleared`.

Exit: glance at the map, see runway state.

### Phase 3 - Auto-occupancy

- `runwayOccupancy.ts` ticker.
- Override behavior: occupied trumps manual state in the API response, manual state preserved as `manualState`.
- `lastOccupancyChange` surfaced in the panel.

Exit: a pilot vessel near runway 09 with `radarAlt < 30 m` flips the runway to occupied within 5 s; vacating restores the previous manual state.

### Phase 4 - Pilot-side mirror

- Pilot kneeboard (when [PILOT_KNEEBOARD_PLAN.md] eventually ships - catalog 2.1) reads runway state for assigned runway.
- Until then: telemetry response carries `assignedRunwayState` so the in-game ACARS panel can show a small chip.

Exit: pilot sees the same color the tower set.

### Phase 5 - Conflict-engine seed (links to roadmap section 4)

- The runway state model becomes the *input* to the conflict engine in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 4 when that work begins.
- This plan is then marked superseded by the roadmap section's automated state machine.
- Documented as the "v0 manual mode" the automated system replaces.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Two controllers race to set the same runway | Last-writer-wins with `lockedByUserId` recorded; both clients see the change immediately via polling/SSE. Optimistic locking can come later if it becomes a problem. |
| Stale `cleared` state lingers because tower forgot to free it | Auto-expire `cleared` after the assigned session leaves the runway bounding box for >30 s, returning to `free`. Logged in timeline. |
| Occupancy detector false positive (aircraft taxiing past on adjacent taxiway) | Conservative bounding box that's the runway proper, not the apron. Tunable per runway via `widthM` in config. |
| `runways.json` malformed | Validate on load; fall back to empty list with a loud warning; UI shows "no runways configured." |
| Pilot doesn't know the new state | Until the kneeboard exists, telemetry response carries `assignedRunwayState`; ACARS panel shows a one-line chip. |
| Manual state confused after auto-occupied flips | API always returns both `state` (effective) and `manualState` (what controller set); UI shows manual state as a small badge under the effective chip. |

---

## Test plan

- Set hold-short, refresh, state persists.
- Two tower clients both see the change within poll cadence.
- Auto-occupancy fires when a test vessel is placed at threshold + 10 m AGL.
- Auto-occupancy clears when vessel moves >100 m past runway end.
- `clear` action requires an assigned session; UI prevents it without one selected.
- `runways.json` malformed input rejected with a clear error.
- Map overlay updates within 1 s of state change.

---

## Files touched

**Backend (new)**

- `backend/data/runways.json` - declarative runway table.
- `backend/src/services/runways.ts` - loader + geometry helpers.
- `backend/src/services/runwayLocks.ts` - state store (Redis).
- `backend/src/services/runwayOccupancy.ts` - auto-occupancy ticker.

**Backend (edits)**

- [backend/src/routes/api.ts](backend/src/routes/api.ts) - 4 new endpoints.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - join runway state into the existing tower-aircraft response so a single fetch carries everything.

**Web (new)**

- `web/src/components/RunwayPanel.tsx`.
- `web/src/components/RunwayMapOverlay.tsx`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount panel + overlay.

**Plugin (edits, Phase 4)**

- [PluginSrc/TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) - parse `assignedRunwayState` from response.
- [PluginSrc/TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) - one-line runway state chip.

**Catalog + roadmap cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 3.4 to point at this doc.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 4 to note this is the manual v0 that the automated state machine will inherit data from.
