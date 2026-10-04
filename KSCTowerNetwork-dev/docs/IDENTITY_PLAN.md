# Identity: Squawk Codes + Custom Callsigns - Plan

## Purpose

Two small data fields, plumbed everywhere, that together turn anonymous `Kerbal-1234` sessions into recognizable identities controllers can talk to and reason about:

- **Callsign** - human-chosen handle the pilot picks once on their profile (`Bobcat 7`, `Jeb Air 101`). Used in voice transcripts, strips, scorecard, kneeboard, and map markers.
- **Squawk** - 4-digit transponder code the tower assigns to a session. Standard ATC vibe; emergency codes (7700/7600/7500/1200) drive UI urgency state.

Lifted from [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) sections 2.3 + 6.1 into one combined plan because they share the same surfaces and ship together as the "identity pass."

---

## Current state

Already exists at the data layer (good news, less to build):

- [backend/src/services/repository.ts](backend/src/services/repository.ts) line 155 declares `callsign?` on the session record.
- Line 765 `defaultCallsign(pilotUserId, id)` generates an auto callsign at session create.
- Line 784 INSERT includes both `squawk` and `callsign` columns.
- Line 966 SELECT pulls them back out.

What's missing:

- Callsign isn't user-editable; everyone gets the auto-generated one.
- Squawk isn't tower-editable; it's set at session create and never touched.
- Neither field is rendered in most UI surfaces.
- No validation rules, no uniqueness check, no emergency-code semantics.

---

## Design intent

- **Callsign is per-account, not per-session.** Pick once, use forever. Auto-generated default for first-time users.
- **Squawk is per-session and tower-mutable.** Tower types it on the strip; pilot HUD picks it up on the next telemetry tick.
- **Emergency codes drive UI**, not the other way around. Setting 7700 changes marker color, surfaces an alert, and (eventually) freezes the strip from auto-archival. Setting 1200 means VFR / unassigned and is the nominal default.
- **Reserved prefixes can't be claimed.** `KSC-TOWER-*` (from ghost plan), `ATIS-*`, `BOT-*`, anything matching a controller seat name.

Cross-references: [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) (entry); [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) (reserved `KSC-TOWER-*` prefix); [REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 8 (emergency squawks feed the alert engine).

---

## Non-goals

- No callsign auctions, registrations, or payment.
- No squawk code uniqueness enforcement (real ATC reuses codes; we will too).
- No real Mode-S transponder simulation.
- No "Heavy" / "Super" weight suffix logic in v1 (covered by catalog 2.5).

---

## Components

### 1. Callsign on the user account (backend)

- New field on the user/profile record. Stored alongside the existing user table; nullable so legacy users keep working.
- Default: keep `defaultCallsign(userId, sessionId)` for users who haven't set one.
- New endpoints in [backend/src/routes/api.ts](backend/src/routes/api.ts):
  - `GET /v1/profile/me` - returns callsign + display name + role.
  - `PUT /v1/profile/callsign` - body `{ callsign }`, validated.
- Validation rules:
  - Regex: `^[A-Z][A-Z0-9 -]{1,15}$` (letters + digits + space + hyphen, 2-16 chars, must start with a letter).
  - Trim + uppercase normalize on input.
  - Reserved-prefix denylist enforced: `KSC-TOWER`, `ATIS`, `BOT`, `GUARD`, `EMERGENCY`, `TEST`, controller seat names from frequency config.
  - Profanity filter against a small static list; rejection returns a generic "callsign not allowed" without revealing the list.
  - Uniqueness across all users (case-insensitive). 409 on conflict with a suggestion: append a number.
- On change: existing sessions for that user keep their old callsign (the session row was snapshotted at create); new sessions use the new callsign.

### 2. Session callsign override (backend)

- Tower can override a session's callsign for that session only (e.g. test flight gets `TEST 1`).
- New endpoint: `PUT /v1/session/:id/callsign` (tower role).
- Same validation as profile callsign except uniqueness is *per active session*, not global.

### 3. Squawk control (backend)

- New endpoint: `PUT /v1/session/:id/squawk` (tower role).
- Body: `{ squawk: "1200" }`.
- Validation: exactly 4 octal digits (0-7). Anything else rejected.
- On set, write to the session row, broadcast via the same telemetry response polling pilots already use ([TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) returns server data on each POST - extend to include `squawk`).
- Special-code side effects:
  - `7700` (emergency): emit a critical alert into the future alert engine ([REAL_TOWER_ROADMAP.md](REAL_TOWER_ROADMAP.md) section 8); marker color flip; freeze auto-archival.
  - `7600` (radio failure): emit a warning alert; tower UI shows "comm failure" badge.
  - `7500` (hijack): emit a critical alert; suppressed visual treatment so it doesn't tip off the "hijacker" (real-world convention).
  - `1200` (VFR): clear any active alerts for this session.
- Auto-set hooks (deferred to other plans, called out here for design coherence):
  - Mayday button (catalog 1.6) -> auto-set `7700`.
  - Voice connection lost for >30 s -> auto-set `7600`.

### 4. Web surfaces

| Surface | What changes |
|---------|--------------|
| [PilotProfile.tsx](web/src/components/PilotProfile.tsx) | Editable callsign field with live validation feedback. |
| [TowerDesk.tsx](web/src/pages/TowerDesk.tsx) | Each strip shows callsign as the prominent label; squawk field is a 4-char input on the strip card; map markers labeled with callsign; emergency squawks flip marker color (red for 7700/7500, amber for 7600). |
| [Scorecard.tsx](web/src/session/Scorecard.tsx) | Replace anonymous session ids with callsign throughout. |
| [ChatDesk.tsx](web/src/pages/ChatDesk.tsx) | Voice transcript and chat lines prefixed with callsign. |
| [LobbyPage.tsx](web/src/pages/LobbyPage.tsx) | Active-pilot list shows callsign + squawk. |

New small component `web/src/components/SquawkInput.tsx`: 4-digit masked input with validation + emergency-code highlight.

### 5. Plugin surfaces

[TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) gets:

- A read-only line: `CALLSIGN: BOBCAT 7   SQUAWK: 1200`.
- When squawk == 7700/7600/7500, line flashes amber/red.

[TowerLoginGui.cs](PluginSrc/TowerLoginGui.cs) extension:

- After login, if the user has no callsign on their profile yet, prompt for one before letting them proceed.
- Same validation as the web side, server-side enforced.

### 6. Telemetry response augmentation

[TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) already parses `nextTelemetrySeconds` and `countdown` from the response. Add parsing for:

- `assignedSquawk` (string, 4 chars).
- `assignedCallsign` (string).

Cache them in `TowerCountdownState`-style static fields so the GUI components can read without re-polling.

### 7. Reserved-prefix registry

Single source of truth in `backend/src/services/reservedNames.ts`:

```ts
export const RESERVED_CALLSIGN_PREFIXES = [
  "KSC-TOWER",
  "ATIS",
  "BOT",
  "GUARD",
  "EMERGENCY",
  "TEST"
];
```

Imported by both the profile validator and the session-callsign validator. Future: pull controller seat names from frequency config so `GROUND` etc. are reserved automatically.

---

## Phasing

### Phase 1 - Profile callsign

- Profile endpoint + `PUT /v1/profile/callsign`.
- Validation, reserved-prefix check, uniqueness.
- [PilotProfile.tsx](web/src/components/PilotProfile.tsx) edit UI.
- Login flow prompts on first login.

Exit: a user can set `BOBCAT 7` from the web; rejected for invalid / reserved / taken.

### Phase 2 - Session squawk control

- `PUT /v1/session/:id/squawk` with role gate + validation.
- `SquawkInput` on the strip card.
- Telemetry response carries `assignedSquawk`; plugin parses it and shows on the in-game ACARS panel.

Exit: tower types `1200` -> pilot's HUD shows it within one telemetry tick.

### Phase 3 - Surfaces sweep

- Replace every place currently showing `Kerbal-1234` style ids with callsign across all web pages and plugin GUIs.
- Voice transcripts (when those land) prefix with callsign.

Exit: no UI-visible session-id-as-name appears anywhere.

### Phase 4 - Emergency code semantics

- `7700` / `7600` / `7500` / `1200` side effects implemented.
- Map marker color changes.
- Tower UI banner for emergency squawks.
- Hooks for Mayday button (catalog 1.6) and voice-loss auto-7600 stubbed.

Exit: setting 7700 on the strip flips marker red and emits a console-visible alert event.

### Phase 5 - Polish

- Profanity filter.
- "Suggest a callsign" button using a small static list of phonetic-friendly options.
- Optional: callsign history for moderation review.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Existing sessions in the DB with `Kerbal-####` callsigns | Migration script: leave old sessions alone; only new sessions adopt new callsigns. |
| Two users want the same callsign | First-come-first-served. Suggestion API offers numeric suffix. |
| Pilot abuses callsign for offensive content | Reserved-prefix + profanity filter on input; admin can force-rename via existing admin endpoints. |
| Squawk typo by tower (`9999`) sets nonsense | Strict 0-7 regex; UI mask prevents typing 8 or 9. |
| Emergency-squawk alerts fire repeatedly on no-op resets | Debounce: only emit alert on transition into emergency code, not on every PUT that re-confirms it. |
| Telemetry response gets large with new fields | `assignedSquawk` is 4 bytes, `assignedCallsign` is <16 bytes. Negligible. |
| Hijack code 7500 visible treatment tips off a "hijacker" | Render 7500 the same as 1200 to the affected pilot's client; only tower sees the alert. (Mirror real-world convention; cosmetic but worth getting right.) |

---

## Test plan

- Profile callsign accepts `BOBCAT 7`; rejects `bob`, `KSC-TOWER`, `🚀`, 17-char strings, duplicates.
- Squawk accepts `1200`, `7700`, `0000`; rejects `8000`, `12345`, `12A0`, empty.
- Strip squawk update propagates to in-game ACARS within one telemetry tick.
- Emergency code transition emits exactly one alert.
- 7500 hidden from pilot client.
- Reserved prefix denylist hot-reloadable.

---

## Files touched

**Backend (new)**

- `backend/src/services/reservedNames.ts`.

**Backend (edits)**

- [backend/src/services/repository.ts](backend/src/services/repository.ts) - profile callsign field, validation hooks, callsign uniqueness query.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) - 3 new endpoints (`/profile/me`, `/profile/callsign`, `/session/:id/squawk`, `/session/:id/callsign`).
- DB migration: `ALTER TABLE users ADD COLUMN callsign TEXT UNIQUE COLLATE NOCASE` (or DB-equivalent).

**Web (new)**

- `web/src/components/SquawkInput.tsx`.

**Web (edits)**

- [web/src/components/PilotProfile.tsx](web/src/components/PilotProfile.tsx).
- [web/src/pages/TowerDesk.tsx](web/src/pages/TowerDesk.tsx).
- [web/src/session/Scorecard.tsx](web/src/session/Scorecard.tsx).
- [web/src/pages/ChatDesk.tsx](web/src/pages/ChatDesk.tsx).
- [web/src/pages/LobbyPage.tsx](web/src/pages/LobbyPage.tsx).

**Plugin (edits)**

- [PluginSrc/TowerAcarsGui.cs](PluginSrc/TowerAcarsGui.cs) - callsign + squawk lines.
- [PluginSrc/TowerLoginGui.cs](PluginSrc/TowerLoginGui.cs) - first-login callsign prompt.
- [PluginSrc/TowerTelemetryPublisher.cs](PluginSrc/TowerTelemetryPublisher.cs) - parse `assignedSquawk` + `assignedCallsign` from response.
- [PluginSrc/TowerCountdownState.cs](PluginSrc/TowerCountdownState.cs) - sibling static state class for squawk/callsign.

**Catalog cross-link**

- Update [ROLEPLAY_FEATURES_CATALOG.md](ROLEPLAY_FEATURES_CATALOG.md) sections 2.3 and 6.1 to point at this doc.
