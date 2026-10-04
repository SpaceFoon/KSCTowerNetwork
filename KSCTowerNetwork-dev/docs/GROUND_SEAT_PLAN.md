# Ground Controller Seat - Plan

> **World scoping:** Inherits position scoping from [HANDOFF_PLAN.md](HANDOFF_PLAN.md) and runway/polygon scoping from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md), both `(worldId, airportId)`-keyed per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). `holdShortPolygons` and parking polygons live on the world-scoped runway file; the `stripPhase` detector reads each vessel's world from telemetry to look up the right polygons. User-level `controllerScopes` are world-agnostic.

## Purpose

First multi-seat expansion: split Ground from Tower. Ground owns taxi clearances, pushback, and movement on the airport surface; Tower owns runway operations and pattern. The two seats share the airport but speak on separate frequencies, see filtered strip lists, and hand off via the position model.

This is the *first real exercise* of three foundational systems shipped earlier:

- [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) - Ground = `freq-gnd-ksc`, Tower = `freq-twr-ksc`. Already declarative.
- [HANDOFF_PLAN.md](HANDOFF_PLAN.md) - position model already supports `tower-ksc` and `ground-ksc` with `frequencyId` + `stripFilter`.
- [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) - Ground sets `hold-short`, Tower sets `cleared` / `line-up`. Two seats with different write scopes.

So most of the heavy lifting is already done. This plan is mostly about: classifying strips into a "phase of flight on the surface" so they can be filtered, the role/permission split, and the small UI variant of TowerDesk.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 4.1.

---

## Design intent

- **Sub-flag on `controller`, not a new role.** Adding `controller_ground` as a separate role doubles every authorization check. Use a sub-capability set (`scope`) on the existing `controller` role; positions enforce *which* scope a seat needs.
- **Strip phase is derived, not declared.** Phase (`pushback / taxi / hold-short / lineup / takeoff-roll / airborne / pattern / inbound / final / landing-roll / parking`) is computed from telemetry + runway lock state in the same module shape as [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md)'s detector. Strips filter on phase.
- **Ground sees "ground domain" strips, Tower sees "air domain" strips, with a managed transition window.** A strip near a phase boundary appears on *both* desks for ~30 s so handoff can be coordinated visually before the position handoff fires.
- **Ground writes to a constrained set of state.** Hold-short locks, ground frequency NOTAMs, taxi clearances. Cannot grant takeoff. Tower retains exclusive `cleared` / `line-up`.
- **Identical UI shell, different filter + write scope.** No new desk. `TowerDesk.tsx` already takes a "scope" prop in spirit; this plan formalizes it.

Cross-references: [HANDOFF_PLAN.md](HANDOFF_PLAN.md) (positions), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) (Ground frequency), [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) (write scope split), [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md) (phase detector pattern), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 3 (clearances) + 6 (handoff).

---

## Non-goals

- No taxiway routing graph in v1 (3.3 Progressive taxi instructions covers that as its own plan when ready).
- No automatic Ground→Tower handoff at runway threshold. Manual via the existing handoff modal in v1; auto-hand at hold-short crossing is a Phase 5 add.
- No Approach / Departure seat - that's 4.2, separate plan when ready.
- No taxiway-conflict detection. Ground operates by eyeball.
- No pushback truck simulation. "Pushback approved" is a verbal clearance + a logged event, no physics.
- No new bridge/voice changes - per-frequency channels already shipped.

---

## Components

### 1. Capability scope on `controller` role

Extend `backend/src/services/webAuth.ts`:

```ts
type ControllerScope = "tower" | "ground" | "approach" | "delivery" | "all";

interface User {
  // ... existing ...
  controllerScopes?: ControllerScope[];   // empty/undefined = "all" (back-compat)
}
```

- `all` is the default for any existing `controller` user (back-compat: nobody loses a seat).
- Admin can edit a controller's scopes via [AdminDesk.tsx](web/src/pages/AdminDesk.tsx) → user editor.
- Scope is checked at *position claim* time and at *write* time on scope-restricted endpoints.

### 2. Position scope mapping

Each entry in `positions.json` (from [HANDOFF_PLAN.md](HANDOFF_PLAN.md)) gains a `requiredScope`:

```jsonc
[
  { "id": "tower-ksc",    "displayName": "KSC Tower",     "frequencyId": "freq-twr-ksc",  "stripFilter": "air-domain",    "requiredScope": "tower" },
  { "id": "ground-ksc",   "displayName": "KSC Ground",    "frequencyId": "freq-gnd-ksc",  "stripFilter": "ground-domain", "requiredScope": "ground" }
]
```

`POST /v1/tower/positions/:id/claim` rejects with 403 if the user lacks `requiredScope` (and isn't `all`).

### 3. Strip-phase detector

New `backend/src/services/stripPhase.ts`. Same architectural shape as [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md)'s `patternDetector`: per-vessel state machine driven by telemetry.

```ts
type StripPhase =
  | "pre-flight"
  | "pushback"
  | "taxi"
  | "hold-short"
  | "lineup"
  | "takeoff-roll"
  | "airborne"
  | "pattern"
  | "inbound"
  | "final"
  | "landing-roll"
  | "parking"
  | "complete";
```

Decision rules per frame (simplified):

| Condition | Phase |
|-----------|-------|
| `situation = prelaunch` AND `wheelsOnGround` AND vessel inside parking polygon | `pre-flight` |
| `wheelsOnGround` AND `groundSpeedMs < 0.5` AND in parking → exit transition fires `pushback` |
| `wheelsOnGround` AND `groundSpeedMs in [1, 12]` AND outside runway box | `taxi` |
| `wheelsOnGround` AND vessel within `hold-short-line` polygon AND `groundSpeedMs < 0.5` | `hold-short` |
| `wheelsOnGround` AND inside runway box AND `groundSpeedMs < 5` | `lineup` |
| `wheelsOnGround` AND inside runway box AND `groundSpeedMs > 5` AND accelerating | `takeoff-roll` |
| `!wheelsOnGround` AND `currentPatternLeg ∈ {departure, crosswind, downwind, base, final, upwind}` | `pattern` |
| `!wheelsOnGround` AND outside pattern bounds AND inbound (closing on threshold) | `inbound` |
| `!wheelsOnGround` AND `currentPatternLeg = final` | `final` |
| Just transitioned `final → wheelsOnGround` | `landing-roll` (until ground speed <5 and exits runway box) |
| `wheelsOnGround` AND off runway after landing AND in taxi-back movement | `taxi` (re-enters) |
| `wheelsOnGround` AND in parking AND `groundSpeedMs ≈ 0` for >5 s post-landing | `parking` |
| Session ended / vessel removed | `complete` |

Hysteresis: 3 frames same as pattern detector; one-shot transitions for takeoff-roll / landing-roll bypass.

`hold-short-line` polygons added to [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s `runways.json`:

```jsonc
{
  "id": "ksc-09",
  // ... existing ...
  "holdShortPolygons": [
    [ [lat,lon], [lat,lon], [lat,lon], [lat,lon] ]
  ]
}
```

Outputs:

- `currentStripPhase` per session, included in tower-aircraft + telemetry response.
- Phase transitions logged for the timeline.

### 4. Strip filters

Centralize in `backend/src/services/stripFilters.ts`:

```ts
type StripFilter = "air-domain" | "ground-domain" | "in-pattern" | "all";

function phasesForFilter(f: StripFilter): StripPhase[] {
  switch (f) {
    case "ground-domain": return ["pre-flight","pushback","taxi","hold-short","lineup","landing-roll","parking"];
    case "air-domain":    return ["lineup","takeoff-roll","airborne","pattern","inbound","final","landing-roll"];
    case "in-pattern":    return ["pattern","final"];
    case "all":           return all phases;
  }
}
```

Note `lineup` and `landing-roll` appear in *both* ground and air domain - that's the boundary window. Ground stops being responsible the moment Tower issues `cleared` for takeoff (lineup → takeoff-roll); Tower stops the moment the strip reaches taxi after landing.

### 5. Strip ownership boundaries (handoff hint)

When a strip's phase enters the boundary (`lineup`, `landing-roll`), the seat that *currently owns* the strip (per simple convention: Ground owns until takeoff-roll; Tower owns from takeoff-roll until taxi) gets a yellow chevron suggesting handoff. Click → opens the handoff modal from [HANDOFF_PLAN.md](HANDOFF_PLAN.md) pre-filled.

In v1 this is purely a UI nudge; ownership transfers when the controller actually executes the handoff. No automatic ownership switch (mitigates "wait, who's calling shots?" confusion).

### 6. TowerDesk scope variant

[TowerDesk.tsx](web/src/pages/TowerDesk.tsx) already renders strips. Add a `scope` prop derived from the user's *active position* (from PositionBar in [HANDOFF_PLAN.md](HANDOFF_PLAN.md)):

```tsx
const activePosition = useActivePosition();
const stripFilter = activePosition?.stripFilter ?? "all";
const visibleStrips = useTowerAircraft({ filter: stripFilter });
```

Visual differences when `scope = ground`:

- Strip card prominently shows `currentStripPhase` next to callsign chip.
- "Hold short" / "release to runway" buttons replace "cleared takeoff" / "line up and wait".
- Map view opens zoomed to airport surface (configurable bounding box) instead of pattern view.
- Voice tuner pre-selects Ground frequency on first claim.
- `RunwayPanel` from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) shows runways read-only except for `free ↔ hold-short` toggle. `cleared` and `line-up` buttons disabled with a tooltip "Tower-controlled."

When `scope = tower`:

- Existing TowerDesk look + write scope.
- Ground-domain strips visible only during boundary window (`lineup`, `landing-roll`).

A future `scope = approach` reuses the same machinery with its own filter.

### 7. RunwayLocks write scope enforcement

Update [backend/src/services/runwayLocks.ts](backend/src/services/runwayLocks.ts) to accept a `requiredScope` per state transition:

| Transition | Scope required |
|------------|----------------|
| `* → hold-short` | `ground` or `tower` |
| `* → cleared` | `tower` only |
| `* → line-up` | `tower` only |
| `* → free` | `tower` only |
| `cleared → occupied` (auto) | system |

Server-side enforcement; the disabled-button UX above is a hint, the gate is here.

### 8. Voice / frequency wiring

Already in place from [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md). Ground seat's auto-tune behavior:

- On `claim ground-ksc` → if `freq-gnd-ksc` not in current monitor set, add it; set as primary.
- On `release ground-ksc` → leave the frequency monitored unless user explicitly untunes (avoids audio cliff during a quick release).

No new bridge code.

### 9. Pilot-side awareness

The existing `Active controller: <callsign>` line on [TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) (added in [HANDOFF_PLAN.md](HANDOFF_PLAN.md)) is extended to a small list:

```
Active controllers:
  Ground:   KIRBY
  Tower:    BOBCAT 7
```

Sourced from the same `positions` field in the telemetry response - `repository.ts` joins all positions for the airport, the plugin renders the subset that's owned.

---

## Phasing

### Phase 1 - Capability scope + position scope

- `controllerScopes` field on user.
- Admin user editor in `AdminDesk` to set scopes.
- `requiredScope` on `positions.json`.
- Claim endpoint enforces.

Exit: a controller with `["tower"]` scope cannot claim `ground-ksc`.

### Phase 2 - Strip-phase detector

- `stripPhase.ts` per-vessel state machine.
- `holdShortPolygons` added to `runways.json` for KSC 09/27.
- `currentStripPhase` joined into responses + telemetry payload.
- Timeline log on phase transition.

Exit: roll out to runway → `taxi → hold-short → lineup → takeoff-roll → airborne` observable in API and timeline.

### Phase 3 - Strip filters + scoped TowerDesk

- `stripFilters.ts` and the `scope` prop on TowerDesk.
- Ground seat UI variant (buttons, map zoom, voice auto-tune).
- Boundary-window dual visibility (`lineup`, `landing-roll`).

Exit: same browser, same user with `all` scope, can claim `ground-ksc` and see only ground-domain strips with ground UI.

### Phase 4 - Write-scope enforcement on runway locks + handoff hints

- `runwayLocks.ts` enforces transition scope.
- Yellow chevron on boundary-phase strips.
- Pre-filled handoff modal from chevron click.

Exit: ground controller cannot click "cleared takeoff"; chevron at `lineup` opens a handoff modal pre-filled to Tower.

### Phase 5 - Pilot awareness + polish

- Plugin shows active controller per scope.
- Ground frequency NOTAMs cross-reference (already covered in [NOTAM_PLAN.md](NOTAM_PLAN.md), just verify integration).
- Optional auto-suggest handoff on phase boundary (tower-side toast: "Bobcat 7 is on landing-roll - take ownership?").

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Ground and Tower disagree about who owns a strip mid-boundary | Convention is Ground-owns-until-takeoff-roll, Tower-owns-until-taxi-after-landing. Documented in admin help; chevron + handoff modal makes the transition explicit. |
| Strip flickers between `taxi` and `hold-short` near the line | 3-frame hysteresis in detector + a 5-second debounce on `taxi → hold-short` transitions specifically. |
| Existing `controller` users lose seats due to scope rollout | Default `controllerScopes = undefined` interpreted as `all`. No migration for current users. |
| Two ground controllers race-claim `ground-ksc` | Already handled by [HANDOFF_PLAN.md](HANDOFF_PLAN.md)'s `SET NX` ownership. |
| Ground seat can't see emergencies on Tower frequency | Ground monitors Tower frequency by default (read-only), via the multi-room grant from [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md). Switching primary stays manual. |
| `holdShortPolygons` mis-drawn → strips never reach `hold-short` | Validation script + admin tool to draw/edit polygons (Phase 5 polish). Until then, hand-author with care; Phase 2 includes an "expected phase" debug overlay on the map. |
| Ground UI changes confuse existing Tower users | Scope check is per *active position*, not per user. A user with `all` scope sees Tower UI when no position claimed; sees Ground UI only when actively on Ground. |
| Boundary window strips visible to both = double-clearance risk | Visible ≠ writable. Tower can't clear taxi; Ground can't clear takeoff. Server enforces. |
| Approach seat (4.2) wants different filter logic | `stripFilters.ts` is the extensibility point; add `inbound-far` filter when 4.2 ships. No re-architecting. |
| Plugin "Active controllers" line gets long with 4+ seats | Renders only owned positions; KSC currently maxes at 4. If overflow, abbreviate displayName. |
| Auto-tune on claim trips users who manage frequencies manually | Toggleable in user prefs `autoTuneOnPositionClaim` (default true). |

---

## Test plan

- User without `ground` scope hits `claim ground-ksc` → 403.
- User with `ground` scope claims `ground-ksc` → ownership transfers, voice tunes to Ground, UI flips to Ground variant.
- Phase detector: pre-launch → pushback → taxi → hold-short → lineup → takeoff-roll → airborne.
- Ground-domain filter shows the vessel through `hold-short` and disappears on `takeoff-roll`.
- Air-domain filter picks up the vessel from `lineup` (boundary) and keeps it through landing.
- Boundary-phase strip appears on both desks during `lineup` for at least 5 s.
- Ground controller clicks "cleared takeoff" button → button is disabled with tooltip; even via crafted POST, server returns 403.
- Handoff chevron on `lineup` strip → handoff modal pre-filled to Tower.
- After handoff acknowledged, ownership transfers per [HANDOFF_PLAN.md](HANDOFF_PLAN.md); strip no longer chevron-flagged.
- Existing `controller` user with default scopes can still claim Tower (back-compat).
- Two ground controllers race claim → loser sees 409.
- Plugin telemetry response includes `currentStripPhase` and active-controllers list.
- Ground monitors Tower frequency by default, can hear emergency on Tower freq without retuning primary.

---

## Files touched

**Backend (new)**

- `backend/src/services/stripPhase.ts` - per-vessel phase detector.
- `backend/src/services/stripFilters.ts` - filter → phase set mapping.

**Backend (edits)**

- [backend/src/services/webAuth.ts](backend/src/services/webAuth.ts) - `controllerScopes` field; capability check helper.
- [backend/data/positions.json](backend/data/positions.json) (from [HANDOFF_PLAN.md](HANDOFF_PLAN.md)) - `requiredScope` per position.
- [backend/data/runways.json](backend/data/runways.json) (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - `holdShortPolygons` per runway.
- [backend/src/services/positions.ts](backend/src/services/positions.ts) (from [HANDOFF_PLAN.md](HANDOFF_PLAN.md)) - enforce `requiredScope` on claim.
- [backend/src/services/runwayLocks.ts](backend/src/services/runwayLocks.ts) (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - per-transition scope enforcement.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - join `currentStripPhase` + active-controllers list into tower-aircraft + telemetry responses.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - admin user-editor endpoints to set scopes; tower-aircraft endpoint accepts `?filter=` param.
- Telemetry ingest entry point - call `stripPhase.onFrame(...)` after the existing per-frame processing.

**Web (new)**

- `web/src/components/GroundDeskButtons.tsx` - hold-short / release-to-runway etc.
- `web/src/hooks/useActivePosition.ts`.
- `web/src/hooks/useStripFilter.ts`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - `scope` prop, conditional buttons, map zoom, boundary chevron.
- [web/src/pages/AdminDesk.tsx](web/src/pages/AdminDesk.tsx) - user-editor UI for `controllerScopes`.
- `web/src/components/RunwayPanel.tsx` (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - read-only / partial-write rendering based on scope.
- `web/src/components/PositionBar.tsx` (from [HANDOFF_PLAN.md](HANDOFF_PLAN.md)) - scope chip on each position.
- `web/src/audio/useVoiceTuning.ts` (from [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)) - auto-tune on position claim helper.

**Plugin**

- [PluginSrc/TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) - extend the active-controller line into a per-scope list.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 4.1 to point at this doc.
- Update [HANDOFF_PLAN.md](HANDOFF_PLAN.md) `positions.json` example to include `requiredScope`.
- Update [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) to note the per-transition scope split.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 6 to reference this as the first multi-seat exercise.
