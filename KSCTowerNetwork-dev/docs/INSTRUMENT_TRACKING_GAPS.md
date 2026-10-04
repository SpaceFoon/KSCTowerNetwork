# Instrument Tracking Gaps

Audit of the cockpit-instrument list against what `TowerTelemetryPublisher.BuildTelemetryJson` (in [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs)) currently sends to the backend.

> **Status note:** the GPS and temperature-telemetry items below have been lifted into [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md), which owns the work. The IFR-stack items (RMI / HSI / NAV radio / DME) have been **rejected** as out-of-scope for a tower product; see [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) section 3 for the reasoning. They're left in the table below for reference only.

Three buckets:

- **Tracked** — field already in the telemetry payload, controller can read it today.
- **Partially tracked** — we send a related signal (often a boolean or summary) but not the gauge value a pilot sees.
- **Not tracked** — nothing in the publisher today; would need new fields and likely new probes.

---

## Not tracked

These instruments have no telemetry coverage at all. Adding them is mostly stock-API work in `BuildTelemetryJson`; no third-party-mod reflection required unless noted.

| Instrument | Notes / source |
|---|---|
| **Turn Coordinator** | Need yaw rate (deg/s) around the vessel's up axis. Derive from `Vessel.angularVelocity` projected on `upAxis`. |
| **Dynamic Pressure gauge** | `Vessel.dynamicPressurekPa` is stock and free. One float. |
| **Temperature gauges** (Engine / Skin / Internal / Environment / Surface) | We only emit a single `overheating` bool. Lifted into [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) section 2: aggregated max-ratio buckets per category + one hot-part callout, no per-part stream. |
| **RMI** (Radio Magnetic Indicator) — *rejected* | Pilot-side instrument; tower never reads it. Out of scope per [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) §3. |
| **HSI** (Horizontal Situation Indicator) — *rejected* | Pilot-side instrument; tower never reads it. Out of scope per [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) §3. |
| **Navigation Radio Units** (NAV1 / NAV2 tuning state) — *rejected* | Pilot-side instrument; tower never reads it. Out of scope per [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) §3. |
| **Comm Radio Unit** (transceiver tuning state, not signal) | We send `commLink` / `commLinkHome` / `commSignal` from stock CommNet, but no "tuned to 121.7" state. Voice frequency lives server-side in Redis (per the per-frequency plan) and isn't echoed back into telemetry. |
| **DME Unit** (slant range to a tuned navaid) — *rejected* | Pilot-side instrument; tower never reads it. Out of scope per [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) §3. |
| **Engine mode toggle switch** (RAPIER air-breathing ↔ closed-cycle, multi-mode toggles) | `ModuleEnginesFX` / `MultiModeEngine.runningPrimary` is the source. Not currently scanned in `ScanModule`. |
| **Engine Reverse toggle switch** (thrust reverser) | Stock `ModuleAnimateGeneric` on FAR/B9 reverser parts; AJE has its own reverser flag. No probe today. |
| **GPS Display** | We send raw `lat` / `lon` already; missing piece is a cockpit unit that displays it (and waypoints). Lifted into [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) section 1. |
| **Fuel/Air Flow gauge** | Instantaneous fuel flow (kg/s) and intake air flow. `ModuleEngines.fuelFlowGui` and `ModuleResourceIntake.airFlow` per part; we currently sum *quantities* not *rates*. |
| **Yoke** (live control input position) | We send `trim.pitch/roll/yaw` only. Live stick input is `v.ctrlState.pitch` / `roll` / `yaw` (separate from trim). Three more floats. |

## Partially tracked

The signal exists in some form, but doesn't match what the cockpit instrument shows. Worth flagging because the "fix" is usually small.

| Instrument | What we send today | What's missing |
|---|---|---|
| **Brake Force gauge** | `brakes` (on/off bool). | Actual brake torque / wheel-brake percentage. Stock `ModuleWheelBrakes.brakeTweakable` is per-part; would need aggregation. |
| **Power Supply Display** | `resources.electricCharge.{current,max}` (state of charge). | Generation rate (solar / RTG / fuel cell output) and draw rate. Stock has `PartResource` deltas per tick; we'd compute and emit `electricChargeFlow`. |
| **Comm Radio Unit** | `commNetAvailable`, `commLink`, `commLinkHome`, `commSignal` (CommNet status). | The radio's *tuned* state (frequency / mode), and any pilot-side TX/RX activity LED. |

## Tracked

For completeness — these instruments are already covered by existing telemetry fields and need no new work.

| Instrument | Telemetry field(s) |
|---|---|
| Altitude indicator (ASL) | `aslAlt` |
| Radio Altimeter | `radarAlt` |
| Air Speed Indicator (EAS / IAS) | `indicatedAirSpeed` |
| Mach Number gauge | `mach` |
| Vertical Speed Indicator | `verticalSpeed` |
| Heading gauge / Compass | `heading` |
| Ground Speed Indicator | `surfaceSpeed` |
| Artificial Horizon Indicator | `pitch`, `roll` |
| AoA gauge | `aoa` |
| Trim Indicator | `trim.pitch`, `trim.roll`, `trim.yaw` |
| Throttle / Thrust gauge | `throttle`, `engines.totalThrustKn`, `engines.twr` |
| G-meter | `gLoad`, `gLoadMax` |
| Battery charge gauge | `resources.electricCharge.{current,max}` |
| Fuel Quantity gauge | `resources.{liquidFuel,oxidizer,monoPropellant,solidFuel,xenonGas,…}.{current,max}` |
| Flaps setting indicator (FAR) | `far.flap` (when FAR installed) |
| Gear Lever | `gearDown` |
| Flaps control lever (FAR) | `far.flap` (same field as the indicator — we send the setting, not a separate "lever position") |
| Spoilers lever (FAR) | `far.spoiler` (bool, FAR-only) |

---

## Suggested ordering for items not yet planned

Items already lifted (GPS, temperature) live in [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md). For everything else, cheapest wins first — all stock-API, single-field additions to `BuildTelemetryJson`:

1. **Dynamic pressure** — one stock field, useful for the existing overheating/structural alerts.
2. **Yaw rate (turn coordinator) + live stick input (yoke)** — four floats, both come from `Vessel` / `ctrlState` directly.
3. **Engine mode + reverser** — extends the existing `ScanModule` per-part walk; no new third-party probes for stock multi-mode engines.
4. **EC flow + fuel/air flow** — needs a per-tick delta cache; not hard but is the first telemetry field that's *stateful* across frames.
5. **Brake force percentage** — small, but only matters if a tower-side brake-force display ships.

The **RMI / HSI / NAV / DME / GPS** cluster splits into two tracks once you stop assuming all five are tower features:

- **GPS** is really one tower feature (controller-pushed direct-to) sitting on top of two pilot-side prerequisites (position display + waypoint list). Doesn't need a navaid registry — the position fix already ships, the waypoint list is a static JSON. Lifted into [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) section 1.
- **VOR / ILS / RMI / HSI / NAV / DME** are pilot-side instruments a tower controller never reads. Formally **rejected** in [COCKPIT_INSTRUMENTS_PLAN.md](COCKPIT_INSTRUMENTS_PLAN.md) section 3 — out of scope for a tower product, full stop. Reasoning recorded there so this conversation doesn't recur.
