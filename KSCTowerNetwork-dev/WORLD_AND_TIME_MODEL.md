# World and Time Model - Cross-Cutting Design Note

## Why this exists

Every player runs their own KSP instance with their own:

- **World** (planet pack): stock Kerbin, Real Solar System Earth, JNSQ, Kcalbeloh, Galileo, anything modular planet packs ship. The home body has a different name, different radius, different navaid set, a totally different basemap.
- **Universal Time (UT)**: the in-game clock advances independently per save. Two players sharing live location can be at different in-game days, different seasons, different times of day - one is flying at noon under sun, the other at 0300 under stars. Voice/chat happen in real wall-clock time regardless.
- **Airfield identity**: "KSC" exists in stock at `(-0.0972, -74.5577)` on Kerbin and in RSS at `(28.5729, -80.6490)` on Earth. They're not the same airfield. A controller seat at one is not a controller seat at the other.

The codebase already has the right primitives:

- [TowerWorldInventory.cs](PluginSrc/TowerWorldInventory.cs) publishes a [WorldInventory](backend/src/services/worldInventory.ts) per session: home body, radius, atmosphere, planet-pack mod list, navaid list, launch sites.
- [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) ships `universalTime` and `bodyName` on every frame.
- [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) auto-swaps the basemap, navaid set, launch sites, and planet radius based on the *viewer's* world inventory; falls back to Kerbin if no inventory is known.
- [TowerBasemapBaker.cs](PluginSrc/TowerBasemapBaker.cs) bakes a per-world basemap on the client side.

What's missing is *consistent application of those primitives across the new feature plans*. Several recently-written plans (ATIS, NOTAM, runway locks, handoff, ground seat, pattern scoring) implicitly assumed a single-world / single-airfield universe. This note is the authoritative correction; every plan inherits it.

---

## Core concepts

### `WorldId`

Stable identifier for the planet-pack + home-body combination. Server-derived from the published `WorldInventory`:

```ts
function deriveWorldId(inv: WorldInventory): string {
  // Slug of (home body name) + (planet-pack signature). Examples:
  //   "kerbin-stock"
  //   "earth-rss"
  //   "kerbin-jnsq"
  //   "kcalbeloh-..."
  // Planet-pack signature = sorted slugs of mods with category "planet-pack".
  ...
}
```

Two players with the same `WorldId` share geometry, navaids, time-of-day reference (their in-game UT scales align), and *can see each other's ghosts*. Two players with different `WorldId`s cannot - their coordinate systems, day lengths, even seconds-per-day all differ.

### `AirportId`

Stable identifier scoped under a world: `{worldId}/{airfield-slug}` or alternately `(worldId, airfieldId)` tuple. Examples: `kerbin-stock/ksc`, `earth-rss/ksc`, `kerbin-jnsq/ksc-east`. An "airfield" is a named launchSite + runway set, not just a coordinate.

Drawn from `WorldInventory.launchSites` plus a curated overlay file per world (so we can publish runway thresholds and pattern targets that aren't in the planet pack itself).

### Time references (three of them)

| Name | What it is | When to use |
|------|------------|-------------|
| `serverNowMs` | UNIX ms on the backend, single source of truth | Anything *between players*: NOTAM windows, alerts, handoff lifecycles, recordings, audit logs, voice activity, telemetry receivedAt |
| `subjectUt` (per-session) | The publishing vessel's `Planetarium.GetUniversalTime()` | Anything *about that player's vessel*: ATIS time-of-day for their airfield, sun-angle illumination, day/night badge on their marker, season-aware effects |
| `viewerUt` (per-session) | The viewing player's own UT | Anything the *viewer's* in-game state should drive: their own ATIS, their kneeboard clock, their EFB |

Critical rule: **`subjectUt` and `viewerUt` are independent**. The map shows live positions in real wall-clock time but the *informational* layer attached to each marker reflects each player's local UT. This is already the pattern on the marker-click panel.

### Worldview vs subject-world

When a viewer looks at another player's marker:

- The map projection / scale / basemap is the *viewer's* world (no warping to the subject's). If the viewer is RSS-Earth and the subject is stock-Kerbin, the marker appears in the viewer's world *only if* the worlds are compatible (same `WorldId`); otherwise the marker is gated out of the map view and surfaced in a "Different World" sidebar instead.
- The marker-click panel shows the *subject's* local context (their UT, their airfield, their body, their navaid, their day/night state, their wind if available). Pulled from the subject's most recent telemetry frame + their session `worldInventory`.

This is consistent with the "real solar system shows a different map for them" behaviour the user already ships - we're naming it.

---

## Scoping rules per data type

### Always world-agnostic (real-wall-clock only)

- User accounts, callsigns, profiles ([IDENTITY_PLAN.md](IDENTITY_PLAN.md))
- Voice rooms / frequencies of *general* topics (Guard, lobby chitchat) - though see "Per-airport frequencies" below for ATC freqs
- Chat
- Alerts feed ([COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md)) - timestamps are server-time; payloads include subject context for display
- Mayday recordings (always real time)
- Weight class chips ([WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md)) - mass is mass
- Audit log / timeline of system actions

### Always world-scoped

- Runways and pattern geometry ([RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md), [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md))
- Navaids
- Launch sites
- Basemap tiles / SVG, planetary radius
- Ghost visibility ([GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md)) - same `WorldId` only
- Per-airport ATC frequencies ([PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)) - see migration below
- Controller positions ([HANDOFF_PLAN.md](HANDOFF_PLAN.md))
- ATIS broadcasts ([ATIS_PLAN.md](ATIS_PLAN.md))
- NOTAMs ([NOTAM_PLAN.md](NOTAM_PLAN.md)) - airport-scoped, transitively world-scoped
- Strip phase polygons (`hold-short`, parking) ([GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md))

### Mixed

- Strips themselves: the *strip record* is global (one row per active vessel session, lives in `repository.ts`) but the *strip's airfield context* (which runway, which pattern, which holds) is world-scoped via the strip's current world+airport derived from telemetry.
- Tower-aircraft endpoint: serves all aircraft the caller can see, but each one carries its own `worldId` + `airportId` so the UI can group / filter / fade out cross-world aircraft.

---

## Cross-world interactions

Two players with different `WorldId`s sharing a session:

| Interaction | Behavior |
|-------------|----------|
| Voice (general / Guard freq) | Works freely, world-agnostic. |
| Voice (per-airport ATC freq) | Each airport has its own frequency record. RSS-KSC Tower and stock-KSC Tower are *different* rooms even if both display "KSC TWR". A pilot can monitor or transmit on either if scope allows. |
| Chat | Works freely. |
| Ghosts | Only same-world ghosts render (visual + map). Cross-world players appear in a separate "Other Worlds" panel. |
| Map | Each viewer sees their own world's map. Same-world subjects appear as live markers. Other-world subjects appear in the side panel with their own world badge + their airfield + their UT. |
| Marker click | Always shows subject's local context regardless of viewer world. |
| ATIS | Per-airport. A pilot only hears ATIS broadcasts for airports they're tuned to; the UI shows the airport's `WorldId` + `AirportId` next to the broadcast. |
| Handoff position claim | Per-airport. "Tower KSC" requires explicit world disambiguation when more than one world has a "KSC". |
| NOTAMs | Per-airport. Default view shows NOTAMs for the *viewer's* current airport; admin can switch airports. |
| Pattern scoring | Per-vessel, evaluated against *that vessel's* runway. Score data is comparable across worlds only at the metric level (e.g., touchdown sink rate); leaderboard partitions by world+airport. |
| Mayday / alerts | Real wall-clock; alert payload carries subject world+airport so other-world controllers can decide whether to act (usually inform-only). |

---

## Migration shape (applied to existing plans)

Below is the canonical fix for each plan. Every plan should add a "World scoping" subsection and adopt these.

### `RUNWAY_LOCKS_PLAN.md`

- `runways.json` becomes `runways/{worldId}.json` *or* a single file with a top-level `worldId` key per group. Every runway entry inherits its world.
- `runwayLocks` keyed by `(worldId, runwayId)` in Redis; existing single-key writes are wrapped to include world.
- API path becomes `/v1/worlds/:worldId/runways/...` with a back-compat shim that defaults to the caller's session world.

### `PATTERN_SCORING_PLAN.md`

- `pattern` block lives on the world-scoped `runways.json`, not floating.
- `pattern_circuits` table gets `worldId` + `airportId` columns.
- Future leaderboard partitions by `(worldId, airportId, runwayId)` so RSS Earth runway 09 doesn't compete with stock Kerbin runway 09.

### `HANDOFF_PLAN.md`

- `positions.json` becomes per-world: positions are `{worldId, airportId, role}`. Display names disambiguate when multiple worlds have a "KSC Tower".
- Position ownership Redis keys keyed `(worldId, positionId)`.
- Handoff brief carries `worldId` + `airportId`; recipient's modal shows them prominently when ambiguous.

### `GROUND_SEAT_PLAN.md`

- `holdShortPolygons`, parking polygons, taxi geometry all live under the world-scoped runway file.
- `stripPhase` detector reads the *vessel's* current world from telemetry to look up the right polygons.
- Scope checks remain user-level (`controllerScopes`); position scope checks remain per-position (already inherits world via position lookup).

### `PER_FREQUENCY_CHANNELS_PLAN.md`

- `frequencies.json` becomes per-world. A frequency id is `{worldId}/{freq-slug}`. UI label may abbreviate to "KSC TWR" but server uses the disambiguated id.
- Multi-room grants in tokens carry world-scoped frequency ids.
- Voice tuner UI groups frequencies by airport, with the world badge subtle.

### `ATIS_PLAN.md`

- One ATIS bot instance per `(worldId, airportId)`. Joins the airport's `freq-atis-{worldId}-{airportId}` room.
- Broadcast text uses `subjectUt` (the airport's local time) not `serverNowMs`. The "Time 1342 Zulu" line means "1342 in your sim's UT", not server clock.
- Weather + active runway pulled from world-scoped state.
- Multiple ATIS bots can run simultaneously without collision since each has its own room.

### `NOTAM_PLAN.md`

- `airportId` field becomes mandatory; the existing schema already has it - just enforce it must be a real `(worldId, airportId)` tuple.
- `effectiveFromMs` / `effectiveUntilMs` remain in `serverNowMs` (so multiple players see the same window). The ATIS formatter expresses the window in the airport's `subjectUt` for the *broadcast*, but the storage stays wall-clock.
- List endpoint defaults to caller's current world+airport; admin can switch.
- Closure-blocks-`cleared` constraint already keys off airport, fits naturally.

### `COMMS_SAFETY_PLAN.md`

- Alert events get `worldId` + `airportId` on the payload (optional - some alerts are world-agnostic e.g. stuck-mic on Guard).
- Alert banner UI tags world when it doesn't match viewer's world.
- Mayday auto-7700 is world-agnostic: squawk is just a 4-digit identifier, no coordinate.

### `IDENTITY_PLAN.md`

- No change. Callsigns and squawks are world-agnostic.

### `WEIGHT_CLASS_PLAN.md`

- No change.

### `GHOSTS_AND_TOWER_VIEW_PLAN.md`

- Already designed around per-session world (good). Make the same-world rule explicit in the rendering filter: `if (subject.worldId !== viewer.worldId) skip`.
- Tower view (hull-cam) is bound to the *publisher's* world; when a viewer of a different world subscribes, the UI shows a banner "Tower view from Earth-RSS KSC" so they know they're looking at someone else's universe.

---

## Marker-click panel (formalize the existing pattern)

Every existing surface that renders an aircraft marker calls `MarkerInfoPanel({ subjectSessionId })`. The panel resolves:

```ts
const subject = useSessionTelemetry(subjectSessionId);
const subjectWorld = useSessionWorldInventory(subjectSessionId);
const viewerWorld = useViewerWorldInventory();
const sameWorld = subject.worldId === viewerWorld.worldId;
```

And renders, in order:

1. **Identity row**: callsign + squawk + weight class chip ([IDENTITY_PLAN.md](IDENTITY_PLAN.md), [WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md)).
2. **World badge**: subject's world display name + same-world indicator if matched. Diff-world subjects get a clearly different badge color so the viewer knows they can't intercept etc.
3. **Airfield row**: subject's current airport + active runway state ([RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)).
4. **Time / sun row**: subject's local UT, derived day/night, sun angle. Day/night derived from `subjectUt` modulo body's `rotationPeriodSec` plus longitude.
5. **Phase / pattern row**: `currentStripPhase` + `currentPatternLeg` ([GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md), [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md)).
6. **Telemetry row**: alt AGL, ground speed, heading, vertical speed.
7. **Voice row**: subject's primary frequency + monitored set ([PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)).
8. **NOTAMs row**: any active NOTAMs at subject's airport ([NOTAM_PLAN.md](NOTAM_PLAN.md)).

When `sameWorld === false`, action buttons (e.g., "request fuel report", "send taxi clearance") are disabled with a tooltip "Different world".

`MarkerInfoPanel` becomes the canonical place to verify any *new* per-player field is being plumbed end-to-end.

---

## Day / night and sun angle

Day/night per subject is a pure derivation:

```ts
function isDaytime(subjectUt: number, bodyRotationSec: number, lat: number, lon: number, axialTiltDeg: number = 0): boolean {
  // Solar longitude on the body advances with subjectUt.
  // Sun altitude at (lat, lon) sign tells us day vs night.
  ...
}
```

Service: `backend/src/services/celestial.ts` (new). Consumed by `MarkerInfoPanel` and by ATIS (so the broadcast can include "day" / "night" qualifiers if desired). Stock Kerbin assumes zero axial tilt; planet packs that publish a tilt in their inventory get the better calculation.

Out of scope for v1: weather, twilight calculation, eclipses, multi-star systems (some planet packs are binary - punted).

---

## Implementation order

This note is descriptive, not a build plan. Adoption order is:

1. **Derive `worldId`.** Add `deriveWorldId()` to `worldInventory.ts`; expose via existing inventory record. Single change, unblocks everything.
2. **Stamp telemetry.** Existing `bodyName` + new server-side `worldId` join. No new ingest path.
3. **Migrate `runways.json` → `runways/{worldId}.json`.** Land before [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) Phase 1 ships, because every other airport-scoped plan keys off this.
4. **Migrate `frequencies.json` → per-world.** Same time as runways.
5. **Migrate `positions.json` → per-world.** Trivial follow-on.
6. **`MarkerInfoPanel` formalization.** Replace whatever ad-hoc tooltip exists today with the canonical 8-row panel; existing surfaces switch over.
7. **`celestial.ts` for day/night.** Optional polish; nothing blocks on this.

Each subsequent plan opens with a one-paragraph "World scoping" section pointing here.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Existing single-world data needs migration on rollout | Default `worldId = "kerbin-stock"` for any record missing one. Backfill once, retire the migration. |
| Players with planet packs the server doesn't know | `WorldInventory` is self-describing; server records the world id verbatim. New runway/frequency files for new worlds are a content-add, not a code change. |
| `worldId` derivation churns when a planet-pack mod updates | Use the planet-pack mod *id*, not its version. Versioned tweaks don't fork the world. |
| Two players claim same `WorldId` but different mod versions cause coordinate drift | Inventory record carries mod version; on detected drift the side panel warns "version mismatch with N other players" and their ghosts render with a faint outline instead of solid. |
| Cross-world voice on a per-airport freq | Frequencies are per-(world, airport); cross-world players land in different rooms. Documented; not a bug. |
| Admin posts NOTAM for "ksc" without specifying world | Form requires explicit world+airport pick; admin can multi-select to publish to several worlds at once. |
| Old plan text still says "the airport" / "Zulu" / "the runway" singular | This note's per-plan migration shape is the authoritative correction. Plans updated with cross-link pointers. |
| Marker for an other-world player flickers in/out of map | Filter is binary same-world or not; flickering would mean inventory is republishing - we only re-derive `worldId` when the *home body* changes, not on every inventory refresh. |
| Same-world but different airfields | Fine - both render as same-world markers, marker-click resolves the airfield context. |
| Day/night calculation slow at scale | Pure function, microseconds; cache per (subjectSessionId, minute-bucket) if profiling shows it. |
| Players using same `WorldId` but with materially different navaid sets (one runs an extra navaid pack) | Each player publishes their navaid set; tower view uses the *viewer's* navaids overlay, not the subject's. Documented in TowerDesk. |

---

## Files touched (cross-cutting)

**Backend (new)**

- `backend/src/services/celestial.ts` - day/night / sun angle.

**Backend (edits)**

- [backend/src/services/worldInventory.ts](backend/src/services/worldInventory.ts) - `deriveWorldId()`; expose `worldId` on the record.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - join `worldId` + `airportId` into telemetry / tower-aircraft / strip serializers.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - airport / world selectors on every plan-scoped endpoint.
- Each per-airport storage path (runways, frequencies, positions, NOTAMs, ATIS, runway locks) gets the `(worldId, airportId)` key prefix.

**Web (new)**

- `web/src/components/MarkerInfoPanel.tsx` - canonical 8-row panel.
- `web/src/components/WorldBadge.tsx`.
- `web/src/hooks/useSessionWorldInventory.ts`.
- `web/src/hooks/useViewerWorldInventory.ts`.

**Web (edits)**

- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount `MarkerInfoPanel`; fade out cross-world markers; add other-worlds side panel.
- Every consumer of marker tooltips → `MarkerInfoPanel`.

**Plugin**

- No new code; existing [TowerWorldInventory.cs](PluginSrc/TowerWorldInventory.cs) and [TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) already publish what's needed.

---

## Cross-link

Every plan that touches per-airport or per-world state should add a one-line "World scoping" pointer at the top:

```md
> **World scoping:** This feature is `(worldId, airportId)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). All paths, configs, and Redis keys carry both ids; cross-world players see this feature scoped to their own world independently.
```

Plans to update with this pointer:

- [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)
- [PATTERN_SCORING_PLAN.md](PATTERN_SCORING_PLAN.md)
- [HANDOFF_PLAN.md](HANDOFF_PLAN.md)
- [GROUND_SEAT_PLAN.md](GROUND_SEAT_PLAN.md)
- [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)
- [ATIS_PLAN.md](ATIS_PLAN.md)
- [NOTAM_PLAN.md](NOTAM_PLAN.md)
- [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md)
- [COMMS_SAFETY_PLAN.md](COMMS_SAFETY_PLAN.md) (lighter - alerts are world-agnostic, just stamped)

[ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) gets a top-of-file note pointing here.
[REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section header gets the same.
