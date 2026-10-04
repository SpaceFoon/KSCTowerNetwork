# Cockpit Instruments - Plan

## Purpose

Two parallel telemetry tracks lifted from [INSTRUMENT_TRACKING_GAPS.md](INSTRUMENT_TRACKING_GAPS.md):

1. **Tower-pushed direct-to** (the actual tower feature) plus the pilot-side **GPS unit** that consumes it. The unit is a beacon-tied position display, the direct-to is a controller's "proceed direct DESSY" push to a pilot's GPS. Avoids the navaid-registry rabbit hole entirely by reusing what we already send.
2. **Temperature telemetry** - replace the single `overheating` bool with a small structured block so the controller can actually see "engine 92%, skin 67%, hottest part: AE-FF1 nose cone."

The plans share this doc because both are "extend the telemetry payload + add a small UI surface" and ship the same way. They are otherwise independent and can land in either order.

A third section formally **rejects** the rest of the IFR avionics stack (VOR / ILS / RMI / HSI / NAV / DME) as out-of-scope for a tower product, with the reasoning recorded so we don't relitigate it.

Lifted from [INSTRUMENT_TRACKING_GAPS.md](INSTRUMENT_TRACKING_GAPS.md). Cross-references: [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md) (payload shape), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 2.1 (kneeboard / EFB - GPS will live there), [PluginSrc/TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) (where new fields land).

---

## 1. GPS + tower direct-to

### 1.1 Design intent

- **The tower feature is the direct-to push.** Phase 3 is the only part that earns its keep on the controller's screen ("proceed direct DESSY"). Phases 1-2 are pilot-side cockpit candy that *enables* the push, not tower deliverables in their own right - frame them as "free wins we get on the way to Phase 3," not as headline features.
- **No navaid registry.** A GPS unit doesn't need ground transmitters; it needs a position fix and (optionally) a waypoint list. We already have the fix.
- **Beacon = receiver power.** The existing telemetry beacon is the natural "is the GPS box on" master switch. Beacon OFF -> "NO FIX" on the GPS display, mirroring the controller's "BEACON OFF" state. One mental model, no new toggles.
- **Pilot-side rendering for Phases 1-2; backend touch only at Phase 3.** Keeps the early phases cheap to ship and easy to revert if pilots don't actually use them.

### 1.2 Non-goals

- No NAV-radio tuning, no DME, no ILS glideslope - see the "Rejected: IFR stack" section below.
- No moving map inside KSP (the kneeboard will get one later via [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) 2.1; the GPS unit itself is text-only).
- No flight-plan sequencing (multi-leg auto-advance) in Phase 2 - one waypoint at a time. Add later if pilots ask.
- No GPS *spoofing* / failure simulation. Beacon-off already covers the "no signal" case.

### 1.3 Phase 1 - Beacon-tied position display (pilot-side prereq)

Pure plugin work. Zero new telemetry fields, zero backend. Not a tower feature on its own; ships only as the foundation Phase 3 needs to render against.

- New `[KSPAddon(Flight, false)]` MonoBehaviour: `TowerGpsGui.cs`, modeled on the IMGUI patterns in [TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) (draggable Rect, settings-persisted position).
- Toolbar entry on [TowerToolbar.cs](PluginSrc/TowerToolbar.cs) (icon + show/hide toggle).
- Renders, when `TowerModSettings.BeaconActive`:
  - **POS:** `lat,lon` in degrees:minutes (and an optional grid-square format toggle in settings).
  - **ALT:** ASL meters.
  - **TRK:** ground track degrees (computed from `Vessel.srf_velocity` projected on the local horizon - same code as `SurfaceHeadingDegrees` in [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs)).
  - **GS:** ground speed in m/s (toggle to knots in settings).
- When beacon OFF: panel renders dim with "GPS - NO FIX" and last-known position greyed out. Matches the BeaconActive short-circuit pattern already in `TelemetryLoop`.
- Hide automatically in non-Flight scenes (the `KSPAddon` attribute already handles this).

Everything this needs is already a property on `Vessel`. No new wire fields.

### 1.4 Phase 2 - Bundled waypoint list (pilot-side prereq)

Adds the "where am I going?" half so Phase 3 has somewhere to push *to*. Still zero backend, still pilot-side only.

- Bundle a JSON with the plugin: `GameData/KSCTowerNetwork/PluginData/waypoints.json`.
  - Schema: `[ { id: string, name: string, lat: number, lon: number, bodyName: string } ]`.
  - Initial population: KSC runway thresholds (09 / 27, plus the island runway), plus named points already covered in `web/src/data/kerbinAeroCharts.ts` / `kerbinNavaids.ts` (DESSY etc). Aim for ~20-30 entries; this is a static asset, not a registry.
  - Filtered by `bodyName` so Mun / Duna entries don't show up while you're flying around Kerbin.
- GPS panel adds:
  - **Waypoint dropdown** (or hotkey-scrollable list to keep IMGUI cheap) - filtered to current body.
  - **DTW** (distance to waypoint) - great-circle distance using vessel + waypoint lat/lon, scaled by `mainBody.Radius`.
  - **BTW** (bearing to waypoint) - initial bearing, same coordinate frame as `SurfaceHeadingDegrees`.
  - **ETE** (estimated time enroute) - `DTW / max(GS, epsilon)`. Clamp to "--:--" if GS < 1 m/s.
  - **XTE** (cross-track error) - signed perpendicular distance from the great-circle from waypoint-set position to current position. Optional; show only when GS > 5 m/s so it isn't noisy at the gate.
- Loaded once on flight scene entry; re-read on settings hot-reload (matches `TowerModSettings.EnsureLoaded` pattern).
- Tower sees nothing different yet - this is a pilot-only Phase.

### 1.5 Phase 3 - Tower-pushed direct-to (the actual tower feature)

The first phase that needs backend changes - and the only phase that surfaces anything on the controller's screen. Everything in Phases 1-2 exists to make this possible.

- New telemetry field: `gps.activeWaypointId` (string, optional). The plugin POSTs this when the pilot has one selected so the controller can see what they're navigating to.
- Tower button on each strip: "Direct to..." dropdown of the same waypoint list (also bundled or fetched from `/waypoints` endpoint - decide at build time).
- Pushed via LiveKit data message (same channel as the move-user push in [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) section 1.3a) with `suggest` semantics: pilot sees a banner ("Tower suggests: direct DESSY") with **Accept** / **Decline**, defaults to Accept after 8 s.
- Audit entry on every push, same shape as the move-user audit.
- No `force` mode - controllers can't seize the GPS. They can ask only.

### 1.6 Risks / pitfalls

- **Great-circle math at the equator** - lat/lon arithmetic is fine for KSC but breaks down near the poles. Use the proper haversine formula even though it's overkill at low latitudes; it's a 6-line function that just works everywhere.
- **Body-radius scaling** - distances must use `vessel.mainBody.Radius`, not Kerbin's hardcoded radius. Otherwise the same plugin reads wrong distances on Real Solar System.
- **JSON parse cost on flight load** - 30 entries is nothing, but cache the parsed list in a static so re-entering the scene doesn't re-read the disk file.
- **Lat/lon display rounding drift** - showing 6 decimal places looks "GPS-y" but suggests false precision. Two decimal places + degrees-minutes-seconds toggle matches what real handheld GPS units show.

---

## 2. Temperature telemetry

### 2.1 Design intent

- **One block, fixed shape.** Don't emit a per-part array - the controller doesn't read 200 part names, and big craft would blow the payload size. Aggregate into named buckets that map to cockpit gauges.
- **Ratios, not raw kelvin.** Pilot gauges read "75% of max" not "1248 K". Send ratios so the consumer doesn't need to know each part's max temp; the alert rule becomes a constant threshold across the fleet.
- **One hot-spot callout.** When something is genuinely cooking, the controller wants the *name* of the part - "your AE-FF1 nose cone is at 92%". Send exactly one (the worst offender above a threshold), not a list.
- **Replace, don't extend, the bool.** Keep `overheating` as a derived field on the consumer side ("any bucket > 0.85") so existing UI logic doesn't break, but stop sending it as a top-level.

### 2.2 Non-goals

- No per-part stream. If we ever need per-part for failure post-mortem, that's a separate "telemetry recording" plan - not this one.
- No predictive "time to failure" - too noisy, especially on re-entry where it's a function of trajectory, not just current temp.
- No skin-vs-internal split per part - we send the *max* of each across the whole airframe; the per-part distinction is rarely actionable.
- No engine-by-engine temp. One bucket for "any engine."

### 2.3 Wire shape

Add to `BuildTelemetryJson` in [PluginSrc/TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) alongside the existing `engines` block:

```jsonc
"temperature": {
  "engineMaxRatio":   0.42,   // max(part.temperature/maxTemp) over ModuleEngines parts; 0 if no engines
  "skinMaxRatio":     0.18,   // max(part.skinTemperature/skinMaxTemp) across all parts
  "internalMaxRatio": 0.31,   // max(part.temperature/maxTemp) across all parts
  "externalC":      -42.6,    // Vessel.externalTemperature, in Celsius
  "atmosphericC":    14.2,    // Vessel.atmosphericTemperature, in Celsius
  "hotPart": {                // optional; null when no part > 0.70
    "name": "AE-FF1 Airstream Protective Shell",
    "ratio": 0.92,
    "kind": "skin"            // "skin" | "internal" | "engine"
  }
}
```

All five ratio/Celsius fields are always present (zero when N/A) so the consumer can render fixed columns without null-checks. `hotPart` is the only nullable field and is omitted entirely below the 0.70 threshold to keep tower UI from flickering.

### 2.4 Producer changes

- Extend `PartScan` (the existing single-pass aggregator) with the four max-ratio accumulators + the hot-part candidate (track the single highest-ratio part across the whole airframe, with its `partInfo.title`).
- `Vessel.externalTemperature` and `Vessel.atmosphericTemperature` are stock; emit them straight out, converting K -> C in `BuildTelemetryJson`.
- Per-engine temps: `ModuleEngines` exposes `temperature` indirectly via the part. Use `part.temperature / part.maxTemp` for engine-mounted parts (i.e. parts that have a `ModuleEngines` module). Don't try to read engine-internal nozzle temps - they're not exposed and pilots don't see them either.
- Threshold for `hotPart` is 0.70 (matches the existing 0.85 overheating alert with a 15-point lead so the controller sees "warming up" before the alert fires).

### 2.5 Consumer changes

- Backend: extend `telemetrySchema` with the new block (optional fields with defaults so old plugin builds keep validating).
- Tower UI: small temperature cluster on the strip. Three bars (engine / skin / internal) colored green/yellow/red at 0.70 / 0.85, plus a "HOT: `<name>` 92%" caption when `hotPart` present.
- Derive `overheating = max(engineMaxRatio, skinMaxRatio, internalMaxRatio) > 0.85` on the consumer side. Drop the wire field one release after the consumer change ships.

### 2.6 Risks / pitfalls

- **Per-tick part-walk cost** - we're already walking `v.parts` once in `ScanParts`; adding four max-ratio probes is free. Do *not* introduce a second pass.
- **Faulty third-party part modules** - the existing per-module try/catch in `ScanModule` already protects us; new code lives inside the same wrapper.
- **External temp during re-entry** - `Vessel.externalTemperature` spikes to thousands of degrees during plasma; that's accurate but the tower UI needs to clamp the display range, not the wire value.
- **Schema migration** - old plugin builds don't send the new block. Backend must treat the whole `temperature` object as optional and keep emitting derived `overheating` from the legacy bool when only that field is present.

---

## 3. Rejected: IFR avionics stack (VOR / ILS / RMI / HSI / NAV / DME)

Explicitly **out of scope** for this product. Captured so we stop relitigating it.

### 3.1 Why these are not tower features

A tower controller never reads a pilot's NAV/VOR/ILS/HSI/RMI/DME. Those are pilot-side instruments for *how* a pilot navigates and lands; the tower's operational reality is "cleared ILS 09 approach, contact tower 118.5" and then "you're on final, cleared to land" - none of which require the tower to see what the pilot's localizer needle is doing. The tower cares about position and intent, not instrumentation.

The three edge cases that *sound* like exceptions don't survive scrutiny:

| Possible use | Actually needs the IFR stack? |
|---|---|
| Approach controller seat ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) §4.2) vectoring to FAF | No - distance/bearing to runway threshold from lat/lon is enough. |
| Approach-plate scoring extension to [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md) | No - "did the pilot stay within ILS tolerances" scores from position alone. |
| IFR-rated player wanting a localizer needle to chase | Yes - but this is pilot-side cockpit candy, not a tower feature. It would belong in a separate "instrument flying mod," not here. |

### 3.2 Why we're saying "rejected" not "deferred"

"Deferred" implies we'll get to it eventually and the only blocker is sequencing. That isn't true here - the stack would still be the wrong thing to build *after* every other tower feature ships, because it still wouldn't show anything useful on a controller's screen. Calling it rejected is more honest and prevents it from drifting back into the backlog every time someone surveys "missing instruments."

### 3.3 What would change our mind

A *new* requirement that genuinely needs ground-transmitter modeling on the tower side. Concrete examples (none of which exist today):

- A "NAVAID OUT OF SERVICE" NOTAM type that's distinct from the runway/frequency NOTAMs in [NOTAM_PLAN.md](NOTAM_PLAN.md) - i.e. a regulatory affordance that operates on transmitters as first-class entities.
- A regulatory ATC scenario (engine failure on a coupled ILS approach, missed approach to a holding pattern at a named VOR fix) that the training scenarios in [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) §5.5 want to script *with NOTAM-style state changes*, not just visual markers.

Cosmetic "I want a VOR needle in my cockpit" isn't enough - that's a separate plugin's problem. If this section ever does come back, it's still *one* project (shared registry, shared per-tick "compute relative to fixed point" math), not five.

---

## Suggested phasing

| Order | Item | Why |
|------|------|-----|
| 1 | Temperature telemetry (Section 2 in full) | Smallest blast radius, free-rides the existing part scan, immediately useful for the existing `overheating` alert path. The only item here that's a tower feature on day one. |
| 2 | GPS Phase 1 | Pilot-side prereq for the direct-to push. Pure plugin work, no schema risk. Don't ship as a headline feature - it shows up in the pilot's cockpit, not on the tower. |
| 3 | GPS Phase 2 | Pilot-side prereq for the direct-to push. Validate the waypoint-list shape with real pilots before Phase 3 builds against it. |
| 4 | GPS Phase 3 (the actual tower feature) | Only after a controller asks for direct-to. Backend touch + LiveKit data plumbing. |
| -- | IFR stack | Rejected per Section 3 - not "later," *not at all* unless the requirements there change. |

---

## Cross-cutting notes

- **Settings hygiene**: each new toggle (GPS panel show/hide, units, hot-spot threshold) should land under one named feature flag, per the same rule called out in [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) "Cross-cutting risks." Don't add three independent booleans.
- **Beacon coupling**: any new instrument that consumes telemetry from the publisher should treat `BeaconActive=false` as "NO FIX" or equivalent, never as zeroed-out fake data. Document the convention in [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) when this plan ships.
- **Wire-shape stability**: the `temperature` and `gps` blocks are the first new top-level objects since the original payload locked. Be conservative - add fields nullable, never rename, never reuse names. Backend schema additions go in the same PR as the publisher change so the wire never lies.
