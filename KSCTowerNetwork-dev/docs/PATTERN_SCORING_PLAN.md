# Pattern Work Scoring - Plan

> **World scoping:** This feature is `(worldId, airportId, runwayId)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). The `pattern` block lives on the world-scoped runway file; `pattern_circuits` rows carry `worldId` + `airportId`; future leaderboards partition by world+airport+runway so RSS Earth runway 09 doesn't compete with stock Kerbin runway 09.

## Purpose

Closed-traffic ("doing circuits") scoring mode. The backend watches telemetry, classifies which leg of the standard rectangular pattern the aircraft is on (`upwind|crosswind|downwind|base|final|touchdown|rollout`), and emits structured per-leg events. [Scorecard.tsx](web/src/session/Scorecard.tsx) renders a per-circuit row with the metrics most pilots actually want to grade themselves on:

- Downwind altitude (vs target)
- Downwind ground track offset (vs target lateral)
- Base turn distance (abeam → base turn)
- Final intercept (lateral + vertical at 1 nm)
- Threshold crossing height (CTH)
- Touchdown distance from threshold
- Touchdown sink rate
- Rollout centerline tracking

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 5.3.

---

## Design intent

- **Server-side detection.** Pattern leg is a property of the *trajectory*, not a UI state - belongs in the same telemetry-consuming layer that already powers strips. One detector, all consumers (Scorecard, Tower Desk strip, future kneeboard, future training scenarios).
- **Geometry-driven, not pilot-declared.** Pilot does not pick "I'm on downwind"; the detector infers it from position + heading + altitude AGL relative to runway geometry. This is the only honest way to score.
- **One circuit = one row.** No infinite-scroll log; one Scorecard row per closed circuit, scrollable history.
- **Reuses runway geometry.** [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) already declares thresholds and bounding boxes; this plan extends the same `runways.json` with pattern-relative metadata (target altitude, traffic side, downwind offset).
- **Targets are configurable per runway.** "Standard pattern" varies per airfield; pilots get a per-runway profile they can also override per session for instructional differences.
- **Consumer of telemetry, not a new ingest path.** Same flow as `WEIGHT_CLASS_PLAN.md` - pure derivation.

Cross-references: [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) (runway geometry source), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 4 (conflict engine consumes pattern leg) + 5 (sequencer consumes pattern leg) + 7 (timeline persistence), [WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md) (same derive-only architecture), [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) (training scenarios consume pattern events for ghost-driven AI traffic), [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md).

---

## Non-goals

- No instrument approach scoring (ILS / RNAV) - that's [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) 5.1.
- No SID/STAR scoring - that's 5.2.
- No competition leaderboard - that's 5.4 (separate plan when ready).
- No mid-circuit instructor coaching ("you're high, descend") in v1 - just metrics, no advice.
- No detection of arbitrary patterns (overhead break, racetrack at 8 nm) - left/right rectangular only in v1.
- No grading rubric / pass-fail score - present the numbers, let pilots compare to targets.

---

## Pattern model

### Legs

```ts
type PatternLeg =
  | "departure"   // post-takeoff climbout straight ahead, before crosswind
  | "upwind"      // straight ahead beside the runway (after crosswind, opposite of takeoff direction)
  | "crosswind"   // 90° turn after departure
  | "downwind"    // parallel to runway, opposite direction
  | "base"        // 90° turn from downwind, perpendicular to runway
  | "final"       // aligned with runway, inbound
  | "touchdown"   // wheels-on
  | "rollout"     // on-ground deceleration
  | "go-around"   // power up before touchdown
  | "off-pattern"; // not currently in a recognizable circuit
```

### Geometry per runway

Extend [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s `runways.json` with a `pattern` block:

```jsonc
{
  "id": "ksc-09",
  "thresholdLat": -0.0972,
  "thresholdLon": -74.5577,
  "headingDeg": 90,
  "lengthM": 2500,
  "widthM": 60,
  "pattern": {
    "trafficSide": "left",         // "left" | "right"
    "tpaAglM": 305,                // target pattern altitude AGL (1000 ft)
    "downwindOffsetM": 1500,       // perpendicular distance from runway centerline
    "baseDistanceFromThresholdM": 2000,  // ideal base turn position abeam → in
    "finalInterceptDistanceM": 1850, // 1 nm in real-world feel
    "patternBoundsRadiusM": 5000   // anything farther = off-pattern
  }
}
```

If a runway omits `pattern`, scoring is disabled for it but locks (`RUNWAY_LOCKS_PLAN.md`) still work.

### Per-session profile override

Optional per-session pattern targets (stored on the session record):

```ts
interface PatternProfileOverride {
  tpaAglM?: number;
  downwindOffsetM?: number;
  baseDistanceFromThresholdM?: number;
  finalInterceptDistanceM?: number;
}
```

Lets an instructor set "tonight's TPA is 1500 ft for this trainee" without editing the global config.

---

## Detection algorithm

Lives in `backend/src/services/patternDetector.ts`. Per-vessel state machine driven by each telemetry frame.

### Per-frame inputs

From the existing telemetry payload:

- `lat`, `lon`, `altitudeAglM`, `headingDeg`, `groundSpeedMs`, `verticalSpeedMs`, `situation`, `wheelsOnGround`.
- Runway = active runway from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) state ("active" = the one with cleared/cleared-for-takeoff state most recently). Tie-break: nearest threshold by great-circle distance, gated to `patternBoundsRadiusM`.

### Derived per-frame

- `runwayRelativePosition` = (along-track m, cross-track m) computed by projecting (lat,lon) into a runway-aligned local frame.
- `runwayRelativeHeading` = `headingDeg − runway.headingDeg` normalized to `(-180, 180]`.
- `legCandidate` chosen by lookup table:

| Condition | Leg |
|-----------|-----|
| `wheelsOnGround && groundSpeedMs > 1.5` AND `alongTrackM in [0, lengthM]` AND most-recent leg ∈ {final, touchdown} | `rollout` |
| Just transitioned to `wheelsOnGround` from airborne in runway box | `touchdown` (one-frame) → then rollout |
| `|runwayRelativeHeading| < 20°` AND `crossTrackM` within ±150 m AND inbound (alongTrackM decreasing) | `final` |
| `|runwayRelativeHeading - 90·trafficSign| < 25°` AND `alongTrackM < 0` (past departure end) AND descending | `base` |
| `|runwayRelativeHeading − 180°| < 20°` AND cross-track on traffic-side AND within `[downwindOffsetM·0.5, downwindOffsetM·1.6]` of centerline | `downwind` |
| `|runwayRelativeHeading − 90·trafficSign| < 25°` AND alongTrackM > runway end AND climbing | `crosswind` |
| `|runwayRelativeHeading| < 20°` AND alongTrackM < 0 (off departure end, still ahead) AND `altitudeAglM < tpaAglM·0.7` | `departure` |
| `|runwayRelativeHeading| < 20°` AND on traffic-side parallel, opposite direction-of-takeoff (rare) | `upwind` |
| Power up + climb during what was final | `go-around` |
| Otherwise | `off-pattern` |

`trafficSign` = `+1` for left traffic, `-1` for right.

### Hysteresis

Raw `legCandidate` is noisy. Apply:

- 3-frame confirmation: leg only changes if the same candidate appears for ≥3 consecutive frames *or* a definitive transition is met (touchdown → rollout, go-around).
- One-shot transitions (touchdown, go-around) bypass hysteresis.

### Circuit boundary

A "circuit" begins when the vessel transitions `departure → crosswind` (or any `upwind → crosswind`) and ends on the *next* `touchdown` (counted as a full-stop landing or a touch-and-go) or `go-around`. The aborted-at-go-around case still emits a row, marked accordingly.

### Emitted events

```ts
interface PatternEvent {
  sessionId: string;
  vesselId: string;
  runwayId: string;
  leg: PatternLeg;
  enteredAtMs: number;
  exitedAtMs?: number;          // filled on transition out
  metrics?: PatternLegMetrics;  // computed at exit
}
```

Per-leg metrics struct:

```ts
interface PatternLegMetrics {
  // Downwind
  downwindAvgAglM?: number;
  downwindAglDeviationM?: number;       // signed, positive = high
  downwindAvgOffsetM?: number;
  downwindOffsetDeviationM?: number;    // signed, positive = wide
  downwindMaxBankDeg?: number;
  // Base
  baseEntryDistanceFromThresholdM?: number;
  baseTurnRateDegPerSec?: number;
  // Final
  finalInterceptCrossTrackM?: number;   // at 1 nm out
  finalInterceptAglM?: number;
  finalAvgGlidePathDeg?: number;
  finalSpeedAvgMs?: number;
  // Touchdown
  thresholdCrossingHeightM?: number;    // CTH at runway threshold
  touchdownDistanceFromThresholdM?: number;
  touchdownSinkRateMs?: number;         // verticalSpeed at wheels-down frame
  touchdownGroundSpeedMs?: number;
  touchdownCrossTrackM?: number;        // off-centerline at touchdown
  // Rollout
  rolloutMaxCrossTrackM?: number;
  rolloutDistanceM?: number;
}
```

All numbers stored in metric units; UI converts per user pref.

---

## Storage

### Live state (Redis)

- `pattern:{sessionId}:current` → `PatternEvent` of the *currently active* leg.
- `pattern:{sessionId}:circuits` → list of completed circuits (capped at 50; older auto-trimmed).

### Persisted history

When a circuit completes, write a row to a new `pattern_circuits` table (or whatever the existing persistence layer is - the audit log path used by [HANDOFF_PLAN.md](HANDOFF_PLAN.md) is the same shape):

```ts
interface PatternCircuit {
  id: string;
  sessionId: string;
  vesselId: string;
  runwayId: string;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "touch-and-go" | "full-stop" | "go-around";
  legs: Record<PatternLeg, { enteredAtMs: number; exitedAtMs: number; metrics: PatternLegMetrics }>;
  summaryMetrics: {
    downwindAvgAglM: number;
    downwindOffsetDeviationM: number;
    finalInterceptCrossTrackM: number;
    thresholdCrossingHeightM: number;
    touchdownDistanceFromThresholdM: number;
    touchdownSinkRateMs: number;
  };
}
```

Survives session end. Becomes the basis for [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 5.4 (leaderboard) when that lands - same shape.

---

## API

In [backend/src/routes/api.ts](backend/src/routes/api.ts):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/session/:id/pattern/current` | Active leg + in-progress metrics. |
| `GET` | `/v1/session/:id/pattern/circuits` | List completed circuits (most-recent first, paginated). |
| `GET` | `/v1/session/:id/pattern/circuits/:circuitId` | Single circuit detail. |
| `PUT` | `/v1/session/:id/pattern/profile` | Set per-session profile override. Owner pilot or controller. |
| `DELETE` | `/v1/session/:id/pattern/profile` | Clear override. |
| `GET` | `/v1/runways/:id/pattern` | Runway pattern config (read-only). |
| `PUT` | `/v1/runways/:id/pattern` | Admin-only edit of runway pattern config (writes to in-memory + persisted JSON). |

SSE stream `GET /v1/session/:id/pattern/stream` pushes leg transitions and circuit-complete events to subscribed UIs (Scorecard, future kneeboard).

---

## Frontend

### Scorecard pattern row

[Scorecard.tsx](web/src/session/Scorecard.tsx) gets a tabbed view: existing "Run" tab + new "Pattern" tab. The Pattern tab renders one row per circuit:

```
#  Outcome   DW Alt        DW Off      Final Δ        CTH       TD Dist    Sink     
1  T&G       1020 ft  +20  1480 m  -20  +12 m left   18 ft     +145 m     -2.1 m/s
2  T&G        940 ft  -60  1610 m +110  +3 m right    9 ft      +60 m     -1.4 m/s
3  Full-stop 1010 ft  +10  1500 m   ≈0  ≈0            6 ft      +25 m     -0.8 m/s
4  Go-around  995 ft   -5  1525 m  +25  -22 m right   --        --        --
```

Color-code deviations: green within target, amber within 2× target, red beyond. Targets pulled from runway pattern config (with profile override applied).

Header strip (above the table):

```
Active runway: 09  |  TPA: 1000 ft  |  DW offset: 1500 m  |  Side: left
Current leg: DOWNWIND (32 s)
```

Per-row click → expand to a detail panel with all metrics from `PatternLegMetrics` per leg + a small mini-map showing the actual track overlaid on the ideal pattern footprint (ideal footprint computed from the pattern config; actual track sampled from telemetry retained for the duration of the circuit).

### Mini-map track

Reuse the map component already on [TowerDesk.tsx](web/src/pages/TowerDesk.tsx). New `web/src/components/PatternTrackMini.tsx` consumes `circuit.legs[*].entered/exited` timestamps + a thinned trail sampled from the existing telemetry trail (one point per ~2 s).

### Live "current leg" pill

On any panel that shows a callsign for the pilot in pattern mode, append a small live pill: `Pattern: DOWNWIND`. Subtle, monochrome, not the same visual weight as `WeightClassChip`.

### Tower Desk surface

Strip card on [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) shows the current leg + last-circuit CTH + touchdown distance for context. Helps tower decide spacing without reading a dozen numbers.

### Plugin surface

Initially none. Field `currentPatternLeg` is added to the telemetry response so a future kneeboard ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) 2.1) can show it without an API change.

---

## Phasing

### Phase 1 - Geometry + leg detection

- Extend `runways.json` schema with `pattern` block; KSC 09/27 entries get realistic values.
- `patternDetector.ts` consumes telemetry, computes leg per frame with hysteresis.
- Redis live state `pattern:{sessionId}:current`.
- `GET /v1/session/:id/pattern/current` returns it.

Exit: fly a textbook circuit, watch the API return downwind → base → final → touchdown in order.

### Phase 2 - Circuit lifecycle + metrics

- Circuit boundary detector (departure→crosswind start, touchdown/go-around end).
- Per-leg metrics computation at leg exit.
- Persistence to `pattern_circuits`.
- `GET /v1/session/:id/pattern/circuits[/:id]`.
- SSE stream.

Exit: completing a circuit produces one persisted row with all summary metrics populated.

### Phase 3 - Scorecard UI

- New "Pattern" tab on Scorecard.
- Row layout, color-coded deviations.
- Expand-to-detail with mini-map track.
- Live "current leg" pill.

Exit: pilot finishes a session of touch-and-goes, opens Scorecard, sees one row per circuit with metrics.

### Phase 4 - Tower Desk + plugin echo

- Strip card shows current leg + last-circuit numbers.
- Telemetry response carries `currentPatternLeg`.
- Profile-override endpoint + a small "set TPA" widget on the pilot's Scorecard header.

Exit: tower glances at strip and sees "Bobcat 11 - DOWNWIND - last CTH 12 ft".

### Phase 5 - Leaderboard prep

- No new code in this plan; `pattern_circuits` shape is intentionally compatible with section 5.4. When that ships, it queries this table.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Detector flips legs spuriously when pilot does S-turns or extends downwind | 3-frame hysteresis; "still on downwind" is the only allowed state if conditions don't strictly indicate transition. Long downwinds simply produce a long leg duration. |
| KSC has no realistic published TPA - pilots will dispute targets | Per-runway config is editable via API; per-session override exists. Document defaults in the runway file with a one-line rationale comment. |
| Wide patterns (3 nm downwind offset for big aircraft) flagged as off-pattern | `patternBoundsRadiusM` defaults to 5 km; tunable per-runway. For Super-class aircraft consider auto-loosening based on `effectiveWeightClass` from [WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md). Phase 5+. |
| Mid-circuit go-around producing partial circuit | Marked outcome `go-around`, summary metrics for legs that *did* execute are recorded; legs after the go-around are not. |
| Telemetry frames arrive bursty / out-of-order | Detector keys off `enteredAtMs` from server clock, not vessel timestamp. Out-of-order frames older than the current leg start are dropped. |
| Two pilots in pattern conflict on "active runway" attribution | Detector uses tower-set active runway from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md); if multiple cleared runways, nearest-threshold tie-break per vessel. |
| Detector cost at 50 active vessels | Per-vessel state machine is O(1) per frame; trivial. Bench at 50 vessels @ 5 Hz before shipping. |
| Pattern config drift between runway file and Scorecard targets | Both read from the same `runways.json`; profile override is read alongside; no duplication. |
| 50-circuit cap loses long sessions | Live cap is 50 in Redis; persisted history is unbounded - Scorecard scrolls into the persisted store via paginated endpoint. |
| Vessels that stop / pause mid-circuit (e.g., rocket flips into pattern oddly) | Off-pattern fallback; circuit aborted as `off-pattern` outcome (in addition to the three above) - actually let's keep the outcome enum to {touch-and-go, full-stop, go-around} and just *drop* circuits that go off-pattern before completion. Document that. |

---

## Test plan

- Five-circuit session of textbook touch-and-goes → 5 rows, all with green deviations.
- Deliberately fly downwind 200 ft high → row shows DW Alt deviation +60 m, color amber.
- Wide downwind at 2× offset → row shows DW Off deviation positive amber.
- Slip in on final crossing centerline at 30 m offset → final intercept Δ shows large lateral.
- Touch-and-go vs full-stop vs go-around → all three outcomes recorded.
- Aborted circuit (vessel goes 5 km out for sightseeing then returns) → no row written, off-pattern logged in current state.
- Toggle traffic-side from left to right in runway config → next circuit detector flips correctly without restart.
- Profile override TPA = 1500 ft → row deviations recompute from new target.
- Two vessels in pattern simultaneously → both get independent state, both write rows.
- Scorecard renders 50 rows + scroll into persisted history without re-fetching everything.
- SSE pushes leg transition within 500 ms of detector decision.

---

## Files touched

**Backend (new)**

- `backend/src/services/patternDetector.ts` - state machine, hysteresis, metrics.
- `backend/src/services/patternRepository.ts` - Redis live state + persisted history.

**Backend (edits)**

- [backend/data/runways.json](backend/data/runways.json) (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - add `pattern` block per runway.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - 7 endpoints + SSE.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - per-session `patternProfileOverride`; include `currentPatternLeg` in tower-aircraft + telemetry responses.
- Telemetry ingest entry point - call `patternDetector.onFrame(...)` after the existing per-frame processing.

**Web (new)**

- `web/src/components/PatternRow.tsx`.
- `web/src/components/PatternTrackMini.tsx`.
- `web/src/components/PatternLegPill.tsx`.
- `web/src/hooks/usePatternStream.ts`.

**Web (edits)**

- [web/src/session/Scorecard.tsx](web/src/session/Scorecard.tsx) - tabbed view; Pattern tab; profile-override widget.
- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - strip card pattern row.

**Plugin**

- None in v1. Field is added to telemetry response for future kneeboard pickup.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 5.3 to point at this doc.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 4 (conflict engine) + 5 (sequencer) to note `currentPatternLeg` as input.
- Update [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) to note the `pattern` block extension.
