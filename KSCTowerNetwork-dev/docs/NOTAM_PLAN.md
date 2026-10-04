# NOTAM Board - Plan

> **World scoping:** NOTAMs are `(worldId, airportId)`-scoped per [WORLD_AND_TIME_MODEL.md](WORLD_AND_TIME_MODEL.md). The existing `airportId` field becomes a `(worldId, airportId)` tuple; admins must explicitly pick world+airport on create (multi-select to publish to several worlds at once). Effective windows stay in `serverNowMs` so all viewers see the same window; the ATIS formatter expresses the window in the **subject airport's** UT for the spoken broadcast.

## Purpose

Notice to Airmen board: admins post a free-text notice with optional structured metadata (effective window, affected runway/frequency, severity), and every pilot/tower surface that displays operational context shows the active set. Closes the loop with the ATIS bot, which auto-quotes any active NOTAM into its broadcast.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 6.5.

---

## Design intent

- **Free-text first, structured second.** A NOTAM is a paragraph of words. The structured fields (severity, runway, frequency, effective window) are *helpers* for filtering and ATIS quotation, not gating.
- **Time-windowed.** Every NOTAM has `effectiveFromMs` and optional `effectiveUntilMs`. Out-of-window NOTAMs are archived, not deleted.
- **Severity drives prominence.** `info` (blue) / `caution` (amber) / `closure` (red). `closure` opens with a banner; `info` lives quietly on the board.
- **Single source of truth for ATIS.** The ATIS service from [ATIS_PLAN.md](ATIS_PLAN.md) reads active NOTAMs and formats them at the end of the broadcast (after weather, runway, altimeter). One feed, one truth.
- **Cheap to ship.** CRUD + a small UI + an ATIS hook. No real-time push needed in v1 - NOTAMs change on minute-scale, not second-scale; cache TTL covers it.

Cross-references: [ATIS_PLAN.md](ATIS_PLAN.md) (ATIS auto-quotes active NOTAMs), [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) (`closure` severity can mark a runway visually), [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md) (NOTAMs can target a frequency), [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 7 (timeline persistence), [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md).

---

## Non-goals

- No ICAO Q-code parsing / authoring. Free-text body, full stop.
- No RNP / restricted area polygons in v1 (pure metadata; map overlay is Phase 4 polish).
- No NOTAM expiry notifications - they just disappear from the active list when their window ends.
- No subscriber email/push - in-app only.
- No edit history beyond an `updatedAtMs` + `updatedByUserId` (timeline picks up the rest).
- No multi-airport scoping in v1 (KSC only); design leaves room.

---

## Data model

```ts
type NotamSeverity = "info" | "caution" | "closure";

interface NotamRecord {
  id: string;
  body: string;                   // free text, ≤ 500 chars
  severity: NotamSeverity;
  airportId: string;              // "ksc" for now
  affectedRunwayIds?: string[];   // refs runways.json
  affectedFrequencyIds?: string[];// refs frequencies.json
  effectiveFromMs: number;
  effectiveUntilMs?: number;      // null = until cancelled
  createdByUserId: string;
  createdAtMs: number;
  updatedByUserId?: string;
  updatedAtMs?: number;
  cancelledByUserId?: string;
  cancelledAtMs?: number;         // soft-cancel marker
}
```

Validation:

- `body` non-empty, ≤500 chars; reject HTML / markdown rendering (display as plain text).
- `affectedRunwayIds` must reference real ids in [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s `runways.json`.
- `affectedFrequencyIds` must reference real ids in [PER_FREQUENCY_CHANNELS_PLAN.md](PER_FREQUENCY_CHANNELS_PLAN.md)'s `frequencies.json`.
- `effectiveUntilMs > effectiveFromMs` if set; max window 30 days (forces re-issuance for long-lived items, prevents zombie NOTAMs).
- `severity = closure` requires `affectedRunwayIds` non-empty.

### Storage

Persisted in the same store the rest of the project uses (whatever backs the audit log / handoff history). New table `notams` keyed by `id`.

Live cache in Redis: `notams:active:{airportId}` → JSON list, refreshed lazily on read with a 30 s TTL or on any write.

### Lifecycle states (derived)

- `pending` - `now < effectiveFromMs`.
- `active` - `effectiveFromMs ≤ now ≤ (effectiveUntilMs ?? ∞)` and not cancelled.
- `expired` - `now > effectiveUntilMs`.
- `cancelled` - `cancelledAtMs` set.

`active` is the only set surfaced to consumers by default.

---

## API

In [backend/src/routes/api.ts](backend/src/routes/api.ts):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/notams?status=active|pending|expired|cancelled|all` | List, default `active`. Public to authenticated users. |
| `GET` | `/v1/notams/:id` | Detail. |
| `POST` | `/v1/notams` | Create. Admin / mod / owner only. |
| `PUT` | `/v1/notams/:id` | Edit body / severity / affected refs / window. Same auth as create. |
| `POST` | `/v1/notams/:id/cancel` | Soft cancel. Same auth. |
| `POST` | `/v1/notams/:id/extend` | Body `{ effectiveUntilMs }`. Convenience to bump expiry. Same auth. |

### Notes

- All writes append a timeline entry (reuses the audit log path).
- All writes invalidate the Redis cache + bump a `notams:version` counter so [ATIS_PLAN.md](ATIS_PLAN.md) regen logic sees the change.
- Read endpoint returns active NOTAMs sorted: closures first by severity → then by `effectiveFromMs` desc.

### ATIS integration

[ATIS_PLAN.md](ATIS_PLAN.md) already debounces regeneration on weather / runway changes. Add `notams:version` to the same hash key so a NOTAM create/edit/cancel triggers an ATIS regen on the same debounce. ATIS reads `GET /v1/notams?status=active`, formats each as a sentence, and concatenates after the standard fields.

Format helper (in `backend/src/services/notamFormatter.ts`, called by both the ATIS service and the web UI for consistency):

```ts
formatForBroadcast(n: NotamRecord): string
// e.g. "Notice: runway 27 closed for maintenance until 1500 Zulu."
```

For ATIS Kerbalizer-fed TTS the formatter strips punctuation that pronounces awkwardly, expands "rwy 27" → "runway two seven", etc.

---

## Frontend

### Admin board

`web/src/components/NotamBoardAdmin.tsx`, mounted on [AdminDesk.tsx](web/src/pages/AdminDesk.tsx):

```
+ NEW NOTAM ───────────────────────────────────────────────
  Severity:  ( ) info  (•) caution  ( ) closure
  Body: [ Runway 27 closed for maintenance ........... ]
        [ ............................................. ]
  Affected runways: [×] ksc-27  [ ] ksc-09
  Affected frequencies: [ ] freq-twr-ksc  [ ] freq-gnd-ksc
  Effective from: [ now ▼ ]   Until: [ +2h ▼ ] (or pick)
  [ Post ]   [ Cancel ]

ACTIVE (3) ────────────────────────────────────────────────
[CLOSURE] Runway 27 closed for maintenance         [edit] [extend +1h] [cancel]
         Effective 1342Z – 1500Z. Affects: ksc-27.
[CAUTION] Bird activity vicinity threshold 09      [edit] [cancel]
         Effective from 1300Z – open ended. Affects: ksc-09.
[INFO]    Squelch tail testing on Tower freq       [edit] [cancel]
         Effective 1340Z – 1400Z. Affects: freq-twr-ksc.

PENDING (1)  EXPIRED (12)  CANCELLED (5)  [show…]
```

### Public surfaces

Compact `NotamStrip` component renders the active set on:

- [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - top header, collapsible to a count chip when none are `closure`.
- [PilotProfile.tsx](web/src/components/PilotProfile.tsx) - sidebar.
- [LobbyPage.tsx](web/src/pages/LobbyPage.tsx) - banner above the session list when any `closure` is active.
- [VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) - small inline list when filtered to a frequency that has frequency-targeted NOTAMs.
- Future kneeboard EFB ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) 2.1) - pulls from the same endpoint.

Severity styling reuses the palette from [WEIGHT_CLASS_PLAN.md](WEIGHT_CLASS_PLAN.md) (info=blue, caution=amber, closure=red) for cross-surface consistency.

### Closure banner

When at least one `closure` is active, a thin red banner sits above the page content:

```
[X] CLOSURE: Runway 27 closed for maintenance until 1500Z
```

Dismissible per session per user (localStorage); reappears on a new closure.

### Map overlay

[RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s `RunwayMapOverlay.tsx` consumes the active NOTAM set and renders a closure-affected runway with diagonal red hatching in addition to its lock-state color. Pure read of `affectedRunwayIds`; no new state.

### Refresh

UI polls `/v1/notams?status=active` on a 30 s interval (matches the cache TTL). No SSE in v1. The closure banner appears within 30 s of post; admins editing see immediate optimistic update.

---

## Phasing

### Phase 1 - CRUD + storage

- `notams` table + `NotamRecord` model.
- 5 endpoints (list/detail/create/edit/cancel + extend).
- `NotamBoardAdmin` on AdminDesk.
- Plain-text body, no rendering.

Exit: admin posts a NOTAM, sees it in the active list; another admin from a separate browser sees it within one poll cycle.

### Phase 2 - Public surfaces

- `NotamStrip` component on Tower Desk + Pilot Profile + Lobby.
- Closure banner on every page (in the app shell).
- 30 s polling.

Exit: posting a `closure` NOTAM puts a red banner on every other connected client within 30 s.

### Phase 3 - ATIS quotation

- `notamFormatter.ts`.
- Hook `notams:version` into ATIS debounce.
- ATIS reads active NOTAMs, formats, appends.

Exit: post a NOTAM, ATIS regenerates within debounce window, broadcast text + audio includes the notice.

### Phase 4 - Map overlay + frequency targeting

- Diagonal red hatching on closure-affected runways in `RunwayMapOverlay.tsx`.
- Frequency-targeted NOTAMs render on `VoiceDesk` per-frequency view.
- Future kneeboard pickup wiring (just the field on telemetry response).

Exit: closing runway 27 visibly hatches it on every map; voice desk shows freq-targeted NOTAMs only on the relevant tab.

### Phase 5 - Polish

- "Reissue from cancelled" action on the admin board (clones into a fresh draft).
- Saved templates (free-text snippets) for common notices - small JSON in `backend/data/notamTemplates.json`.
- "Show in ATIS" toggle per NOTAM (some operational notes shouldn't be broadcast - default true, lets admin suppress).

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| ATIS regenerates too often when admins edit a NOTAM repeatedly | Reuse the existing ATIS debounce (≥ one regen per minute floor). Editing in rapid succession produces one regen at the trailing edge. |
| `closure` banner spam if admins forget to expire | 30-day max window enforced; expired NOTAMs auto-disappear. Admin board flags any closure approaching expiry in last hour with an amber chip. |
| Pilots ignore the banner | Banner is dismissible per session, so it doesn't become wallpaper, but reappears on each *new* closure. Future Mayday-style chime is out of scope. |
| Free-text NOTAMs are profanity / abuse vectors | Reuse the profanity filter from [IDENTITY_PLAN.md](IDENTITY_PLAN.md)'s `reservedNames.ts` style helper applied to body on create/edit. Mods can override with a flag for special cases. |
| ATIS speaks NOTAMs awkwardly | Formatter expands abbreviations (RWY → "runway", numeric runways → digit-by-digit, ZULU pronounced); validator enforces no special chars in body that the TTS chokes on (em-dash, ASCII art). |
| Admin posts a NOTAM referencing a runway id that gets removed from `runways.json` later | Validation fails on read; orphaned NOTAMs surface with a red "stale ref" tag and block ATIS quotation until edited. |
| Two admins edit simultaneously | Last-write-wins on the body; `If-Match` header on PUT with `updatedAtMs` returns 412 on conflict, admin re-fetches and re-applies. |
| `closure` severity overrides runway-lock state visually | Map renders both: hatching for closure, lock state color underneath. Closure overrides only for clearance purposes (tower can't `cleared` a closed runway - enforced server-side in [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)'s state setter; add the gate when this plan ships). |
| Deletion vs cancellation confusion | No hard delete in v1; `cancel` is soft. Admin board doesn't show a delete button. Document in admin help text. |
| Closure-affected runway is the active runway in the ATIS broadcast | ATIS auto-picks an alternate when its active runway is in a `closure` NOTAM (deferring to the runway-lock state for the alternate); if no alternate is `cleared`, ATIS broadcasts "all runways closed - field closed" and tower banner makes that loud. |

---

## Test plan

- Create NOTAM with body, severity, runway → appears in admin active list immediately.
- Closure NOTAM → red banner on TowerDesk, PilotProfile, Lobby within 30 s.
- Cancel → disappears from active set; appears in cancelled tab.
- Edit window to extend by 1 h via `extend` → `effectiveUntilMs` updated; ATIS regenerates next debounce tick.
- Post NOTAM with body containing 7700 / Mayday → not auto-promoted to alert; that's a different system.
- Create NOTAM with `affectedRunwayIds: ["nonexistent"]` → 400 with field error.
- Effective window `from = now+1h, until = now-1h` → 400.
- 30-day-max enforced on window length.
- Admin edits same NOTAM in two tabs simultaneously → second PUT returns 412 If-Match conflict.
- `closure` on runway 27 → map shows hatching + tower can no longer set 27 to `cleared` state.
- ATIS broadcast text + audio includes formatted notice within debounce window.
- Pilot dismisses closure banner → it doesn't reappear that session; new closure → it does.
- 50 active NOTAMs render without layout breakage (admin board paginated).

---

## Files touched

**Backend (new)**

- `backend/src/services/notams.ts` - CRUD, lifecycle derivation, validation.
- `backend/src/services/notamFormatter.ts` - ATIS-friendly formatter.

**Backend (edits)**

- [backend/src/routes/api.ts](backend/src/routes/api.ts) - 6 endpoints.
- [backend/src/services/repository.ts](backend/src/services/repository.ts) - `notams` table; audit-log writer.
- [backend/src/services/atis.ts](backend/src/services/atis.ts) (from [ATIS_PLAN.md](ATIS_PLAN.md)) - subscribe to `notams:version`; append formatted NOTAMs to broadcast.
- [backend/src/services/runwayLocks.ts](backend/src/services/runwayLocks.ts) (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - reject `cleared` state when an active `closure` NOTAM affects the runway.
- `backend/data/notamTemplates.json` (Phase 5).

**Web (new)**

- `web/src/components/NotamBoardAdmin.tsx`.
- `web/src/components/NotamStrip.tsx`.
- `web/src/components/NotamClosureBanner.tsx`.
- `web/src/hooks/useActiveNotams.ts`.

**Web (edits)**

- [web/src/pages/AdminDesk.tsx](web/src/pages/AdminDesk.tsx) - mount admin board.
- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx) - mount strip + closure banner integration.
- [web/src/components/PilotProfile.tsx](web/src/components/PilotProfile.tsx) - mount strip.
- [web/src/pages/LobbyPage.tsx](web/src/pages/LobbyPage.tsx) - closure banner.
- [web/src/pages/VoiceDesk.tsx](web/src/pages/VoiceDesk.tsx) - per-frequency notam list.
- `web/src/components/RunwayMapOverlay.tsx` (from [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md)) - closure hatching.
- App shell - mount global closure banner.

**Plugin**

- None in v1. NOTAM count + top closure body are added to the telemetry response so a future kneeboard ([ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) 2.1) can pick them up.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) section 6.5 to point at this doc.
- Update [ATIS_PLAN.md](ATIS_PLAN.md) to note the NOTAM quotation hook.
- Update [RUNWAY_LOCKS_PLAN.md](RUNWAY_LOCKS_PLAN.md) to note the closure-state-blocking constraint.
