# Aircraft Type / Weight Class Chip - Plan

## Purpose

Derive an ICAO-style wake-turbulence weight class from each session's existing `wetMass` telemetry field and surface a one-character chip (L / M / H / S) on every panel that already shows a callsign or strip. Pure backend derivation; zero new plugin code.

The chip looks tiny, but it earns its keep three ways:

1. **Identity payoff today.** Tower glance: "Munflyer 4 H" reads instantly as a heavy. Pairs with [IDENTITY_PLAN.md](IDENTITY_PLAN.md) callsigns/squawks - same pattern, same surfaces.
2. **Sequencer prep.** Wake-turbulence spacing is the gating constraint for the auto-sequencer in [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 5; this is the data input that lets that work even start.
3. **Voice / phraseology hint.** "Heavy" suffix on the callsign matches real-world ATC convention; can be appended to the voice-transcript prefix automatically.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 2.5.

---

## Design intent

- **Derive, don't store.** `wetMass` already lands every telemetry tick; the class is a pure function of it. No new write path, no new plugin field, no migration.
- **Stable across the flight.** Class is derived from the *first valid* `wetMass` of the session (i.e., on launch / takeoff) and frozen until the session ends. Prevents the chip flickering as fuel burns off mid-flight.
- **Tower can override.** Real ATC sometimes classifies oddly (e.g., B757 special). Tower override stored on the session record; UI shows the override with a subtle visual hint.
- **Single source of truth.** One classifier function, exported from `backend/src/services/weightClass.ts`. Every surface imports from there.

Cross-references: [IDENTITY_PLAN.md](IDENTITY_PLAN.md) (same surfaces), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) sections 4 (conflict engine consumes class) + 5 (sequencer consumes class), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md), [TELEMETRY_AND_TOWER_TRACKING_PLAN.md](TELEMETRY_AND_TOWER_TRACKING_PLAN.md) (telemetry shape).

---

## Non-goals

- No ICAO type-designator picker (B738, A320 etc.) - the class is the only output.
- No live re-classification mid-flight as fuel burns - intentional, see "Design intent."
- No plugin-side UI - chip lives only on web for now (kneeboard from `2.1` will pick it up later).
- No per-engine / per-airframe classification beyond mass thresholds.
- No wake-spacing enforcement here - that's roadmap §5; this plan only feeds it.

---

## Classification

KSP vessels span an enormous mass range (tiny probes through superheavy lifters). Use thresholds tuned to the ATC-fantasy framing rather than literal real-world FAA cutoffs.

```ts
export type WeightClass = "L" | "M" | "H" | "S";

export interface WeightClassResult {
  klass: WeightClass;
  label: "Light" | "Medium" | "Heavy" | "Super";
  derivedFromMassKg: number;
  source: "auto" | "override";
  overrideByUserId?: string;
}

export function classifyByMass(massKg: number): WeightClass {
  if (massKg <= 7_000)   return "L";
  if (massKg <= 50_000)  return "M";
  if (massKg <= 200_000) return "H";
  return "S";
}
```

| Class | Label | Mass cutoff (kg) | Typical KSP example |
|-------|-------|------------------|---------------------|
| L | Light  | ≤7 000     | Stock trainer, single-seat probe carrier |
| M | Medium | ≤50 000    | Mk2 spaceplane, small cargo |
| H | Heavy  | ≤200 000   | Mk3 airliner, medium lifter |
| S | Super  | >200 000   | Saturn-class lifter, mega lifter |

Thresholds live in `backend/data/weightClasses.json` so they're tunable without recompile:

```json
{
  "thresholds": [
    { "klass": "L", "maxKg": 7000,   "label": "Light"  },
    { "klass": "M", "maxKg": 50000,  "label": "Medium" },
    { "klass": "H", "maxKg": 200000, "label": "Heavy"  },
    { "klass": "S", "maxKg": null,   "label": "Super"  }
  ]
}
```

---

## Storage

Add to the session record (in [backend/src/services/repository.ts](backend/src/services/repository.ts)):

```ts
interface SessionRecord {
  // ... existing fields ...
  weightClassAuto?: WeightClass;        // derived once
  weightClassAutoMassKg?: number;       // the mass we derived from
  weightClassOverride?: WeightClass;    // tower-set
  weightClassOverrideByUserId?: string;
  weightClassOverrideAtMs?: number;
}
```

`effectiveWeightClass` = override ?? auto ?? null.

### When auto is captured

In the telemetry ingest path:

- If session has no `weightClassAuto` AND `wetMass > 0` AND `situation in {flying, sub-orbital, landed-with-velocity}` (i.e., not stuck in editor / on launch pad pre-launch) - capture and freeze.
- "Landed with velocity" guard prevents capturing the empty mass of a re-entered shell.
- One-write semantics; subsequent telemetry frames don't reclassify.

### Reset

If the session transitions through `prelaunch` again (rare - means new vessel on the same session id), clear `weightClassAuto` so the next valid frame re-captures. Override is *not* cleared automatically.

---

## API

In [backend/src/routes/api.ts](backend/src/routes/api.ts):

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/v1/session/:id/weight-class` | Tower-only override. Body `{ klass: "L"|"M"|"H"|"S"|null }`. Null clears the override. |
| `DELETE` | `/v1/session/:id/weight-class` | Equivalent to PUT with null. |

Existing surfaces add the field to their response payload, no new GETs needed:

- The tower-aircraft endpoint returns `effectiveWeightClass`, `weightClassSource` (`"auto"|"override"`).
- The session detail endpoint returns the same.
- The telemetry response (read by [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) for any future plugin echo) returns it under a new field; the plugin ignores it for now.

Authorization on the override endpoint: `controller`+; mods can set or clear; logged into the timeline (or, until roadmap section 7 lands, into the existing audit log).

---

## Frontend

### Chip component

`web/src/components/WeightClassChip.tsx`:

```tsx
export function WeightClassChip({ klass, source, size = "sm" }: Props) {
  if (!klass) return null;
  const colorMap = { L: "#7BC74D", M: "#4D94FF", H: "#F2A93B", S: "#E0524F" };
  const labelMap = { L: "L", M: "M", H: "H", S: "S" };
  return (
    <span
      title={
        source === "override"
          ? `${labelMap[klass]} (tower override)`
          : labelMap[klass]
      }
      style={{
        display: "inline-block",
        width: size === "sm" ? 14 : 18,
        textAlign: "center",
        background: colorMap[klass],
        color: "#fff",
        fontWeight: 700,
        borderRadius: 3,
        fontSize: size === "sm" ? 10 : 12,
        marginLeft: 4,
        boxShadow: source === "override" ? "0 0 0 1px #fff inset" : undefined,
      }}
    >
      {labelMap[klass]}
    </span>
  );
}
```

Override chips have an inset white border so a tower can spot at a glance which classifications were edited.

### Surfaces

Render the chip next to the callsign on every existing display:

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - strip header.
- [web/src/components/MapMarkerTooltip.tsx](web/src/components/MapMarkerTooltip.tsx) (or wherever map tooltips live).
- [web/src/session/Scorecard.tsx](web/src/session/Scorecard.tsx) - row header.
- [web/src/components/PilotProfile.tsx](web/src/components/PilotProfile.tsx) - your-aircraft summary.
- [web/src/pages/ChatDesk.tsx](web/src/pages/ChatDesk.tsx) - participant list.
- [web/src/pages/LobbyPage.tsx](web/src/pages/LobbyPage.tsx) - active sessions list.
- [web/src/pages/VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) - voice participant chip (where the user is also a session pilot).

### Override UI

On the strip card (TowerDesk) for each aircraft, the chip is a button. Click opens a small popover:

```
Aircraft: BOBCAT 11
Auto: M  (derived from 18 400 kg)

Override to:
( ) L   ( ) M   (•) H   ( ) S
[ Apply ]   [ Clear override ]
```

Calls `PUT /v1/session/:id/weight-class`. UI optimistic-updates and falls back on 4xx.

### Voice transcript prefix (optional, Phase 3)

Where the future voice-transcript / chat-transcript prefix is generated (single helper expected to land with [VOICE_IMPLEMENTATION_PLAN.md](VOICE_IMPLEMENTATION_PLAN.md)'s captioning), append `" Heavy"` to a callsign on `H`/`S` class. Example: `"Bobcat 11 Heavy"`. Pure formatting, no other side effects.

---

## Phasing

### Phase 1 - Classifier + capture

- `weightClass.ts` service + JSON thresholds.
- Capture-on-first-valid-frame logic in the telemetry ingest path.
- Field added to `SessionRecord`.

Exit: launching a vessel with `wetMass = 18 000 kg` writes `weightClassAuto = "M"` exactly once; subsequent fuel burn does not change it.

### Phase 2 - Surface chip

- `WeightClassChip` component.
- Add to all eight enumerated surfaces.
- Field added to existing API responses (no new endpoints).

Exit: every existing place that shows a callsign also shows a chip; "M" appears on a 18-tonne vessel without any user interaction.

### Phase 3 - Override

- `PUT/DELETE /v1/session/:id/weight-class`.
- Override popover on TowerDesk strip card.
- Inset-border styling for override chips.
- Audit log entry on every override.

Exit: tower can switch a vessel from auto-M to override-H; the inset border appears; clearing returns to auto-M.

### Phase 4 - Voice transcript "Heavy" suffix

- Append `" Heavy"` for `H`/`S` in the shared callsign formatter.

Exit: where applicable, transcripts and any auto-generated voice cues use "Bobcat 11 Heavy" form.

### Phase 5 - Sequencer integration (deferred)

- Roadmap section 5 sequencer reads `effectiveWeightClass` from each strip and applies wake-spacing rules. No code in this plan; just keep the field name stable.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `wetMass` arrives 0 or unrealistically tiny on some launches (e.g., probe-only) | Capture only when `wetMass > 0` and situation indicates real flight. Falls back to no chip until valid. |
| Mid-flight stage drop changes the mass meaningfully (e.g., booster sep) | Frozen at first valid frame; intentional. Override exists for the rare "tower wants to reclassify after sep" case. |
| Thresholds feel wrong after community plays for a while | Externalized in `weightClasses.json`; admins can edit without code change; consider a `?devOverride` query param for tuning sessions. |
| Users build absurd heavies and the chart fills with H/S | The chip is informational; no enforcement here. Sequencer can push back later if desired. |
| Override gets stale after vessel actually changes | Override survives until cleared by tower or session ends; that matches the "tower meant to do this" intent. Document in ops. |
| Plugin echo of the field unused for ages | Field is optional in the response; plugin reads it lazily. Zero cost if not used. |
| Color choices clash with map marker colors from [IDENTITY_PLAN.md](IDENTITY_PLAN.md) (squawk severity) | Reserve red shades for emergencies; use the chosen palette (green/blue/amber/red-but-darker for Super) and re-test contrast on the existing dark TowerDesk background. |
| Captioning helper not yet built when Phase 4 lands | Phase 4 is gated on that helper landing; until then leave callsigns as-is. |

---

## Test plan

- 4 000 kg vessel → chip "L".
- 30 000 kg vessel → chip "M".
- 120 000 kg vessel → chip "H".
- 500 000 kg vessel → chip "S".
- Burn fuel from 30 000 → 8 000 kg mid-flight → chip stays "M" (frozen).
- Tower override M → H → chip shows H with inset border; tooltip says "tower override".
- Clear override → chip reverts to "M", border gone.
- Pre-launch / `wetMass = 0` → no chip on any surface.
- Re-prelaunch on same session id → chip clears and re-captures on next valid frame.
- API rejects invalid klass values (`X`, lowercase, numeric).
- 8 surfaces all render the chip without layout breakage.
- "Bobcat 11 Heavy" suffix appears for `H` / `S` in any caption helper output (Phase 4).

---

## Files touched

**Backend (new)**

- `backend/src/services/weightClass.ts` - classifier, helper getters.
- `backend/data/weightClasses.json` - tunable thresholds.

**Backend (edits)**

- [backend/src/services/repository.ts](backend/src/services/repository.ts) - new fields; capture-on-first-valid-frame; `effectiveWeightClass` derivation in serializers.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - `PUT/DELETE /v1/session/:id/weight-class`; include fields in tower-aircraft + session detail + telemetry responses.

**Web (new)**

- `web/src/components/WeightClassChip.tsx`.
- `web/src/components/WeightClassOverridePopover.tsx`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - chip on strip header + override popover wiring.
- [web/src/session/Scorecard.tsx](web/src/session/Scorecard.tsx) - chip on row header.
- [web/src/components/PilotProfile.tsx](web/src/components/PilotProfile.tsx) - chip on your-aircraft summary.
- [web/src/pages/ChatDesk.tsx](web/src/pages/ChatDesk.tsx) - chip in participant list.
- [web/src/pages/LobbyPage.tsx](web/src/pages/LobbyPage.tsx) - chip in active sessions.
- [web/src/pages/VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) - chip on voice participant.
- Map marker tooltip module (location depends on existing map component) - chip in tooltip.

**Plugin**

- None. Field is added to the telemetry response so a future kneeboard ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 2.1) can pick it up without an API change.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 2.5 to point at this doc.
- Update [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 5 to reference `effectiveWeightClass` as the sequencer input.
