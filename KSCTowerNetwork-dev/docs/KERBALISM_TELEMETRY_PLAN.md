# Kerbalism Telemetry + Resource Burn-down - Plan

> **World scoping:** Kerbalism / stock-derived telemetry is per-vessel (and therefore per-session, which is `(worldId, airportId)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md)). Failure-event alerts inherit the world stamping rules from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md): server-time `createdAtMs`, plus the subject's `worldId` + `airportId` so cross-world controllers can decide whether to act. Storm-window timestamps are in-game UT for human display, server-time for ordering.

## Purpose

Two related telemetry expansions, shipped as one feature pack so they share the reflection probe + alert plumbing:

- **Resource burn-down (catalog 2.4 generalization)** - stock-derived `fuelSecondsRemaining` and `ecSecondsRemaining` on every telemetry frame. Tower can request "POB / fuel / EC" and get a real number, not a vibe. Pure stock, no Kerbalism dependency, ships first.
- **Kerbalism telemetry expansion** - reflection-probed Kerbalism fields (failures, life support, habitat, crew health, storm windows) bundled under a `kerbalism: { ... }` namespace. Failure events specifically auto-arm the MAYDAY flow from [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) without the pilot pressing a button.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 2.4 (POB / fuel / EC) and the deferred Kerbalism bullets at the top of section 4 (collected here so there's one place to look).

---

## Design intent

- **Stock first, Kerbalism second.** EC / fuel seconds are derived from stock `Vessel.GetConnectedResourceTotals` and don't need Kerbalism. They ship in Phase 2 and stand alone. Kerbalism fields are gated behind a single `kerbalismAvailable` capability flag and an opt-in reflection probe that mirrors the existing radiation probe in [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) (line 456).
- **One namespace, not field sprawl.** Move `radiation` / `radiationAvailable` into `kerbalism: { radiation, … }` so the wire shape doesn't grow a sibling boolean per Kerbalism field. `kerbalismAvailable` is the single top-level capability flag. Cross-coordinated with `TowerWorldInventory.cs` so the tower can show "Pilot has Kerbalism" without waiting for the first frame.
- **~~Don't publish what nobody renders.~~** *Reversed at controller request.* Life-support / per-crew dose / storm fields now publish whenever Kerbalism is detected and render directly on the existing Tower Desk Pilot card + map-marker modal. The `KERBALISM_LIFESUPPORT_ENABLED` env-flag gate is dropped. CapCom / Recovery / RangeSafety panels in [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) inherit the same wire shape as a second consumer.
- **Failures are the loudest signal Kerbalism produces; treat them like Mayday.** A part failure on the active vessel is a critical alert: the tower controller is informed, the strip is frozen, the squawk auto-sets to 7700, and the next 60 s of voice records. Same alert ceremony as a manual Mayday in [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) §3, just with `source: "kerbalism-failure"` and a richer payload.
- **alerts.ts is shared infrastructure.** Whichever of this plan or [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) ships first builds `backend/src/services/alerts.ts`; the second one inherits it. This plan assumes alerts.ts exists by Phase 3 — Phase 1 builds it if COMMS_SAFETY hasn't already.
- **Reflection probes never crash the telemetry loop.** Every Kerbalism call is wrapped per the existing radiation pattern: per-frame failures swallow silently; one-time probe failures log once and disable the field. The radiation probe is the reference implementation; reuse `_kerbalismProbed` semantics.

Cross-references: [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) (alerts.ts shape, MAYDAY ceremony), [IDENTITY_PLAN.md](IDENTITY_PLAN.md) (squawk 7700 path), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) §8 (alert engine inherits this shape), [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) (consumer for the deferred life-support fields), [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) §2.4.

---

## Non-goals

- **No Kerbalism dependency at compile time.** All access is reflection-cached, exactly like the existing radiation probe. The plugin must build and run without Kerbalism installed.
- **No part-failure repair UI on the tower.** Tower sees the alert, not a "fix it" button. Repair is a pilot/EVA action in-game.
- **No mission-time predictions.** EC / fuel "seconds remaining" is `current_amount / current_drain`, no integration over a planned profile. Burn rate of zero → field is `null`, not `Infinity`.
- **No Kerbalism storm forecasting beyond what its API exposes.** If `KERBALISM.API.StormIncoming(body)` returns a window, we publish it. We don't infer storms from solar flux.
- **No alternative life-support mods.** USI-LS, Snacks, TAC-LS are out of scope. Kerbalism only. (Cheap to add later — same reflection pattern, different namespace.)

---

## Components

### 1. Plugin: stock burn-down (Phase 2, no Kerbalism dependency)

Extend [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs):

```csharp
private static double? ResourceSecondsRemaining(Vessel v, string resourceName)
{
    if (v == null || v.parts == null) return null;
    double amount = 0d, drain = 0d;
    var def = PartResourceLibrary.Instance.GetDefinition(resourceName);
    if (def == null) return null;
    v.GetConnectedResourceTotals(def.id, out amount, out double maxAmount);
    // Drain = sum of negative resource changes per second across active modules.
    // Use the same pattern KSP's stock burn-time UI uses (see ModuleEngines / KSP RuntimeResources).
    drain = ComputeNetDrainPerSecond(v, def.id);
    if (drain <= 1e-6) return null; // Stable or charging — no useful "remaining" number.
    return amount / drain;
}
```

Two new top-level fields on the telemetry frame:

- `fuelSecondsRemaining: number | null` - LiquidFuel seconds at current burn. Null when not burning.
- `ecSecondsRemaining: number | null` - ElectricCharge seconds at current draw. Null when net-positive (charging or stable).

Both null-friendly: nothing renders the field when null. No Kerbalism dependency. Backend zod and TypeScript type updated to match.

### 2. Plugin: Kerbalism namespace migration (Phase 3 prerequisite)

Move existing radiation field. Wire shape change:

```jsonc
// Before
{ "radiation": 0.0042, "radiationAvailable": true }

// After
{ "kerbalismAvailable": true, "kerbalism": { "radiation": 0.0042 } }
```

Backend keeps reading the legacy fields for one release (set both, prefer the new shape on read), then drops them. `TowerWorldInventory.cs` already detects Kerbalism by name (line 206); plumb that detection into the telemetry frame so `kerbalismAvailable` is true from the very first frame (not gated on the radiation probe finding the API).

### 3. Plugin: Kerbalism failure event probe (Phase 3, the headline feature)

Kerbalism exposes part failures via `KERBALISM.API`:

- Static event `OnPartFailure(Part p, string failureKind, string description)` (subscribe with `+=`).
- Polling helper: `KERBALISM.API.GetFailures(Vessel v)` returns `IList<KerbalismFailureRecord>` for currently-failed parts (varies by Kerbalism version — probe defensively).

Probe reflection lives next to the radiation probe in `TowerTelemetryPublisher.cs`. Subscribe once per flight scene; unsubscribe on `OnDestroy`. On callback:

```csharp
private void OnKerbalismPartFailure(object kerbalismFailureArg)
{
    // Reflect the (Part, kind, description) tuple defensively.
    var v = FlightGlobals.ActiveVessel;
    if (v == null || string.IsNullOrEmpty(TowerModSettings.SessionId)) return;

    StartCoroutine(PostFailureAlert(new {
        sessionId = TowerModSettings.SessionId,
        kind,                                   // "engine" | "rcs" | "controlsurface" | "reactionwheel" | …
        partTitle = part != null ? part.partInfo.title : "",
        description,
        flightTimeSec = v.missionTime,
        atRadarAlt = v.radarAltitude,
        atSurfaceSpeed = v.srfSpeed,
        crewOnBoard = v.GetCrewCount(),
    }));
}
```

POSTed to a new endpoint (Component 4). Falls back to a queued retry on network error so a failure during a 1-second backend hiccup still surfaces.

### 4. Backend: alerts.ts (shared with COMMS_SAFETY) + failure receive endpoint

Build `backend/src/services/alerts.ts` per [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) §1 (single shape, Redis sorted set, four endpoints, SSE stream). This plan ships it if COMMS_SAFETY hasn't.

New endpoint owned by this plan:

- `POST /v1/telemetry/:sessionId/kerbalism-failure` (plugin-only auth via `TowerApiAuth.ApplyBearer`). Body validated with zod:

```ts
const failureSchema = z.object({
  kind: z.string().min(1).max(40),
  partTitle: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  flightTimeSec: z.number().nonnegative().optional(),
  atRadarAlt: z.number().optional(),
  atSurfaceSpeed: z.number().optional(),
  crewOnBoard: z.number().int().min(0).max(64).optional()
});
```

Side effects per failure (matches Mayday ceremony in [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) §3):

1. Write `AlertEvent { severity: "critical", source: "kerbalism-failure", sessionId, payload, createdAtMs }`.
2. Force squawk to 7700 via the same path as Mayday (idempotent — already 7700 → no-op).
3. Freeze the strip (`session.frozen = true`).
4. Trigger 60 s voice recording on the session frequency.
5. Append a critical timeline entry.
6. Idempotent dedupe key: `(sessionId, kind, partTitle)` within a 30-second window. Prevents a part failing repeatedly during plasma blackout from spamming six alerts.

Pilot can resolve the alert in-game via a "STAND DOWN" button on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) (same control as the existing Mayday confirm pattern, just inverted). Tower can resolve from the AlertsBanner.

### 5. Plugin + backend: life-support / per-crew dose / storm window (Phase 4 — brought forward)

> **Status update:** Phase 4 was originally deferred until [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) (CapCom seat) shipped. Brought forward at controller request: "Kerbalism telemetry should include food, atmo, water, O2, nitrogen — or at least the days left." The fields now publish unconditionally when Kerbalism is detected (the `KERBALISM_LIFESUPPORT_ENABLED` env-flag gate is dropped) and render directly on the existing Tower Desk pilot card + map-marker modal. CapCom seat will inherit the same wire shape when it lands; no second migration needed.

Reflection-probed under the `kerbalism` namespace alongside radiation. Each sub-block is independently optional — an old Kerbalism build without `StormIncoming` still publishes `lifeSupport` and `crew`. Field set:

```jsonc
// Top-level (alongside radiation/radiationAvailable, kept for one release of back-compat):
"kerbalismAvailable": true,
"kerbalism": {
  "lifeSupport": {
    // One entry per Kerbalism life-support resource the vessel actually carries (the plugin
    // filters empties so a stock-fuel-only craft isn't bloated). `secondsRemaining` /
    // `daysRemaining` are null when net production is non-negative — there's no
    // "remaining" to predict. Days are in **home-body days** (Kerbin = 6 h, RSS Earth = 24 h)
    // so the controller's reading matches what KSP shows the player.
    "food":            { "amount": 240.0, "max": 600.0, "ratePerSec": -0.0028, "secondsRemaining": 86400, "daysRemaining": 4.0 },
    "water":           { "amount": 90.0,  "max": 240.0, "ratePerSec": -0.0021, "secondsRemaining": 43200, "daysRemaining": 2.0 },
    "oxygen":          { "amount": 18.4,  "max": 60.0,  "ratePerSec": -0.0010, "secondsRemaining": 18420, "daysRemaining": 0.85 },
    "nitrogen":        { "amount": 12.0,  "max": 30.0,  "ratePerSec": 0,        "secondsRemaining": null,  "daysRemaining": null },
    "atmosphere":      { "amount": 101.3, "max": 101.3, "ratePerSec": 0,        "secondsRemaining": null,  "daysRemaining": null },
    "wasteAtmosphere": { "amount": 4.2,   "max": 50.0,  "ratePerSec": 0.0008,   "secondsRemaining": null,  "daysRemaining": null },
    "carbonDioxide":   { "amount": 0.48,  "max": 10.0,  "ratePerSec": 0.0003,   "secondsRemaining": null,  "daysRemaining": null }
  },
  "crew": [
    // Per-kerbal Kerbalism radiation dose. Empty when this Kerbalism build doesn't expose
    // the Radiation(ProtoCrewMember) overload — stock crew stats still surface via the
    // top-level `crewStats` array below.
    { "name": "Jebediah Kerman", "doseRad": 0.84 },
    { "name": "Bill Kerman",     "doseRad": 0.71 }
  ],
  "storm": {
    // Solar storm window for the vessel's current main body. `incoming=false` is published
    // in the calm; `durationSec` only when StormDuration is exposed by this Kerbalism build.
    "incoming": true,
    "durationSec": 14400
  }
},

// Top-level, parallel to crewNames — published regardless of Kerbalism so the crew expansion
// works on stock saves. Per-kerbal Kerbalism dose stays in `kerbalism.crew[]` so the two
// surfaces stay disjoint and either is independently usable.
"crewStats": [
  { "name": "Jebediah Kerman", "trait": "Pilot",     "type": "Crew", "experienceLevel": 5, "experience": 32.0, "courage": 0.50, "stupidity": 0.85, "isVeteran": true,  "isBadass": true  },
  { "name": "Bill Kerman",     "trait": "Engineer",  "type": "Crew", "experienceLevel": 4, "experience": 18.5, "courage": 0.30, "stupidity": 0.10, "isVeteran": true,  "isBadass": false }
]
```

> **Habitat block deferred.** Pressure / breathable / CO₂ ppm are not in this bring-forward — Kerbalism doesn't expose a stable static API for habitat reads, and the controller's "days left" ask is satisfied by the per-resource burn-down. Add when the CapCom seat in [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) demands it.

UI surface: rendered directly on the Pilot telemetry card in [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) + the marker modal in [KerbinTowerMap.tsx](web/src/components/KerbinTowerMap.tsx). One row per LS resource (`Food: 4 d · 240 / 600`), per-kerbal expansion under the Crew row (`Jebediah Kerman · Pilot L5 · C50 S85 · 0.84 rad/s`), and a `Storm: INCOMING · …` row when one is inbound. Future CapCom desk in [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md) inherits the same wire shape — second consumer, no second migration.

### 6. Web: render Phase 2 fields on existing surfaces

Two new rows in the Pilot telemetry table on [TowerDesk.tsx](web/src/pages/TowerDesk.tsx):

- `Fuel: 4 m 12 s @ current burn` (or `—` when null).
- `EC: 38 m @ current draw` (or `—` when null).

Color thresholds: amber under 60 s, red under 15 s. No card border (this is a soft warning surface, not a blackout).

Same two rows added to the marker modal vessel card (the symmetric block already covering radiation / comms).

### 7. Failure-event UI: AlertsBanner + strip badge

Reuses the `AlertsBanner` from `alerts.ts` infrastructure. Failure-source alerts get a wrench icon + "PART FAILURE: ENGINE — 'LV-T30 Reliant'" treatment (mirrors the Mayday red banner styling). Click → strip card opens, with the failure description in the card body and a `Resolve` button.

Strip card (when [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) §3 lands) shows a persistent wrench badge for the duration of any unresolved kerbalism-failure alert tied to that session.

---

## Settings + tunables

Backend env:

- ~~`KERBALISM_LIFESUPPORT_ENABLED`~~ — *removed.* Component 5 ships unconditionally now that it renders on the existing Tower Desk. See Phase 4 status note above.
- `KERBALISM_FAILURE_DEDUPE_WINDOW_MS` (default 30 000) - per-`(sessionId, kind, partTitle)` alert dedupe window.

Pilot-side ([TowerModSettings.cs](PluginSrc/TowerModSettings.cs)):

- `KerbalismFailureAutoMayday` (default `true`) - opt out for players who don't want auto-7700 on failure.
- ~~`KerbalismLifeSupportPublish`~~ — *removed.* The bundle is small (~7 numeric rows + a per-crew dose chip) and the controller wants it always-on. Re-add only if a player asks for an opt-out.

---

## Phasing

### Phase 1 - Alert event scaffolding (shared)

If [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) Phase 1 hasn't shipped: build `alerts.ts`, the four endpoints, SSE stream, `AlertsBanner`, `useAlertsStream()`. Otherwise skip — already done.

Exit: dev `POST /v1/dev/alerts/inject` renders on every connected tower client within 1 s.

### Phase 2 - Stock burn-down (no Kerbalism)

- `fuelSecondsRemaining` + `ecSecondsRemaining` on telemetry.
- Backend type + zod.
- Two rows on the Pilot telemetry card + marker modal.
- Color thresholds (amber < 60 s, red < 15 s).

Exit: a flight with depleting fuel shows a live countdown next to the Mass row that ticks down each telemetry frame.

### Phase 3 - Kerbalism failure events + namespace migration

- Move `radiation` under `kerbalism.radiation`; keep legacy fields for one release.
- Reflection probe for `OnPartFailure` (subscribe in flight scene).
- `POST /v1/telemetry/:sessionId/kerbalism-failure` endpoint.
- Failure-source alert ceremony (squawk 7700, strip freeze, 60 s recording, dedupe).
- Wrench-icon styling on AlertsBanner.
- "STAND DOWN" pilot button on [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs).

Exit: in a Kerbalism save, force a part failure; within 2 s the tower sees a critical wrench banner, squawk reads 7700, strip is frozen, the next 60 s of voice on the session frequency are captured.

### Phase 4 - Life support / per-crew dose / storm window (SHIPPED — brought forward onto Tower Desk)

> Originally deferred until [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md). Pulled forward at controller request — the "days left on food/water/O2" answer is too useful to wait on the CapCom seat.

Shipped:

- Reflection probes for `Kerbalism.API.ResourceAmount` / `ResourceRate` covering Food, Water, Oxygen, Nitrogen, Atmosphere, WasteAtmosphere, CarbonDioxide. Empties filtered out per-vessel.
- Per-resource `secondsRemaining` + `daysRemaining` computed from net rate; `daysRemaining` uses the home body's rotation period so RSS / Kerbin / GPP all read correctly.
- Per-kerbal Kerbalism `doseRad` array via `Radiation(ProtoCrewMember)` overload (defensive — empty when the build doesn't expose it).
- Storm-window probe (`StormIncoming` + optional `StormDuration`).
- Stock crew expansion (`crewStats[]`: trait, level, courage, stupidity, veteran/badass) published unconditionally so the crew detail also works on stock saves.
- UI: per-resource rows + per-kerbal expansion + storm row on [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) Pilot card and the [KerbinTowerMap.tsx](web/src/components/KerbinTowerMap.tsx) marker modal.

Deferred to a later phase (still aligned with the CapCom seat in [MISSION_OPS_SEATS_PLAN.md](MISSION_OPS_SEATS_PLAN.md)):

- Habitat pressure / breathable / CO₂ ppm — Kerbalism doesn't expose a stable static API surface for these and the controller's "days left" ask is satisfied by the per-resource burn-down.
- Per-crew stress / `KerbalismLifeSupportPublish` opt-out / `KERBALISM_LIFESUPPORT_ENABLED` gate — all dropped now that the bundle is unconditional.

Exit (met): in a Kerbalism save with a crewed vessel, the Pilot telemetry card shows live Food / Water / O₂ / N₂ / Atmosphere rows with `Xd Yh Zm` countdowns and the Crew row expands per-kerbal with trait, level, and Kerbalism dose.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Kerbalism API surface changes between versions (it has) | Defensive reflection: probe each method individually, log once on probe failure, mark that field unavailable for the session. Never throw out of a per-frame call. |
| Auto-MAYDAY on failure is too aggressive (a stuck wheel shouldn't 7700) | `KerbalismFailureAutoMayday` opt-out per pilot. Per-`kind` allowlist on the backend (`engine`, `rcs`, `controlsurface`, `parachute` → MAYDAY; `wheel`, `light`, `science` → warning-only alert, no squawk change). |
| Failure spam during plasma reentry blackout (one part fails, then 5 more) | Dedupe within 30 s on `(sessionId, kind, partTitle)`. First failure of each kind raises an alert; subsequent ones extend the existing alert's payload list. |
| EC seconds flips between value and null when batteries cycle (solar dipping behind a wing) | 5-second smoothing on the drain calculation client-side; round to 5-second buckets so the UI doesn't flicker. |
| Backend without Redis renders alerts.ts useless | Same fallback as comms-safety: in-memory store with a warning log, alerts work for one tower client only. |
| `KERBALISM_LIFESUPPORT_ENABLED` accidentally on in production with no UI consumer | Backend logs "publishing lifeSupport bundle to N sessions, no consumer registered" once per minute as a deploy smell. |
| Pilot installs Kerbalism mid-flight | The probe is one-shot per scene load; player must revisit the scene. Acceptable — same constraint as the radiation probe today. |
| Stock `GetConnectedResourceTotals` excludes locked resources (e.g. mid-stage tank cross-feed off) | Documented behavior. Tower sees the *flowable* fuel, which is what matters for "how long until you flame out." |
| Ferram Aerospace control-surface failure not surfaced (FAR not Kerbalism) | Out of scope. Add a parallel `FAR_FAILURE_ENABLED` plan when there's a consumer ask. |

---

## Test plan

- **Stock burn-down:** Stationary craft with engine throttled → `fuelSecondsRemaining` decreases monotonically. Engine off → field becomes null within one frame.
- **EC charging:** Solar panel deployed, sun-side, no draw → `ecSecondsRemaining` is null. Rotate to dark side → field appears with a finite number.
- **Kerbalism not installed:** `kerbalismAvailable === false` in every frame; no `kerbalism` key emitted; legacy `radiationAvailable === false` until Phase 3 deprecates it.
- **Kerbalism radiation namespace migration:** During the deprecation release, both legacy `radiation` AND `kerbalism.radiation` are present and equal. After deprecation, only the namespaced version.
- **Failure → MAYDAY:** Force an engine failure (Kerbalism debug menu) on an active session. Within 2 s: alert event with `severity: critical`, `source: kerbalism-failure`. Squawk on the session reads 7700. Strip is frozen. Voice egress task started.
- **Failure dedupe:** Force two engine failures on different parts within 5 s → one alert with payload listing both. Force a third 35 s later → new alert.
- **Auto-MAYDAY opt-out:** With `KerbalismFailureAutoMayday=false`, force a failure → alert fires (warning severity), but squawk is unchanged and strip is not frozen.
- **STAND DOWN:** Pilot taps STAND DOWN on the radio panel → alert resolved within 1 s, strip unfrozen after 5 min grace, squawk returns to prior value (or remains 7700 if pilot set it manually).
- **Phase 4 life-support burn-down (Kerbalism installed):** Crewed vessel with consuming O₂ tanks → `kerbalism.lifeSupport.oxygen.secondsRemaining` decreases monotonically; `daysRemaining` matches `secondsRemaining / homeBodyDayLength`. Add a Greenhouse module producing food → `kerbalism.lifeSupport.food.secondsRemaining` is `null` (net production non-negative). Resource depleted → row disappears next frame (filtered out by the plugin).
- **Phase 4 per-crew dose:** With Kerbalism's `Radiation(ProtoCrewMember)` available, every kerbal in `kerbalism.crew[]` has a finite `doseRad` ≥ 0 that monotonically increases through a high-radiation flyby. Without the overload, `kerbalism.crew[]` is empty but `crewStats[]` still publishes.
- **Phase 4 storm window:** Force a storm via Kerbalism debug → `kerbalism.storm.incoming === true` and `durationSec` is finite (or absent if the build doesn't expose `StormDuration`). Calm period → `incoming === false`.
- **Phase 4 stock-only:** Kerbalism not installed → `kerbalismAvailable === false`, no `kerbalism` key, but `crewStats[]` still publishes for the Tower Desk crew expansion.

---

## File touchlist

**Plugin (edits)**

- [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) — Phase 2 stock burn-down, Phase 3 Kerbalism failure subscribe + namespace migration, **Phase 4 (shipped)** life-support / per-crew dose / storm-window reflection probes + stock `crewStats[]` emit.
- [TowerRadioGui.cs](PluginSrc/TowerRadioGui.cs) — Phase 3 STAND DOWN button.
- [TowerModSettings.cs](PluginSrc/TowerModSettings.cs) — Phase 3 `KerbalismFailureAutoMayday`. (Phase 4 `KerbalismLifeSupportPublish` was dropped — see Settings + tunables.)
- [TowerWorldInventory.cs](PluginSrc/TowerWorldInventory.cs) — Phase 3 surface `kerbalismAvailable` from inventory probe so first frame already has it.

**Backend (new)**

- `backend/src/services/alerts.ts` — Phase 1 (if not built by COMMS_SAFETY first). Shape per [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) §1.
- `backend/src/routes/kerbalism-failure.ts` — Phase 3 endpoint + zod schema.

**Backend (edits)**

- [backend/src/services/store.ts](backend/src/services/store.ts) — Phase 2 add `fuelSecondsRemaining` / `ecSecondsRemaining`. Phase 3 add `kerbalismAvailable` + `kerbalism` namespace. **Phase 4 (shipped)** add nested `kerbalism.lifeSupport` (Record<string, TelemetryLifeSupportResource>) + `kerbalism.crew[]` (per-kerbal dose) + `kerbalism.storm` + top-level `crewStats[]`.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) — Mirror the type changes.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) — Mirror the zod changes; mount the kerbalism-failure route. **Phase 4 (shipped)** extend `telemetrySchema` with the `kerbalism` block + `crewStats[]`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) — Phase 2 fuel + EC rows on Pilot telemetry card and marker modal. Phase 3 wrench badge on the strip card (when strips land). **Phase 4 (shipped)** per-resource life-support rows, per-kerbal dose / trait / level expansion under Crew, storm-incoming row.
- [web/src/components/KerbinTowerMap.tsx](web/src/components/KerbinTowerMap.tsx) — **Phase 4 (shipped)** matching life-support / per-crew / storm rows in the marker modal; new `formatDuration` + `formatKerbinDays` helpers shared with TowerDesk.
- [web/src/components/AlertsBanner.tsx](web/src/components/AlertsBanner.tsx) (created in Phase 1) — Phase 3 wrench-icon variant for `kerbalism-failure` source.

**Docs (edits)**

- [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) — section 2.4 cross-link, top-of-§4 Kerbalism note.
- [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) — §8 alert engine notes that `kerbalism-failure` is one of the canonical sources.
