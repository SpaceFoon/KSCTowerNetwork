# Telemetry ghosts & tower tracking screen (future work)

This document captures **planned** features for KSCTowerNetwork: (1) optional in-game “eye candy” aircraft driven by remote telemetry, and (2) a **tower-facing tracking screen** so controllers can see where crafts are across active sessions. It complements `VOICE_IMPLEMENTATION_PLAN.md` (voice/Kerbalizer) and does not replace backend session or LiveKit room semantics.

**Scale assumptions (design targets):**

- Roughly **~50 participants** in a shared voice/chat “room” or community context at peak.
- Only **~3–4 pilots** actively needing tower service **at once** (queued or assigned sessions).
- Tower staff need a **single glance** at who is flying, where they are, and staleness—without loading 50 identical rows.

---

## 1) Remote craft visualization (KSP plugin, optional)

**Goal:** In a client’s game, show **non-interactive, physics-light or physicsless** stand-in stock craft that **follow** another session’s telemetry. Visual only; no docking, fuel, or physics interaction.

**Data:** Pilot continues to use `POST /v1/telemetry/:sessionId`. Viewers with permission already receive telemetry via `GET /v1/session/:sessionId` (embedded in `session.telemetry`). Future: lighter read-only endpoint or push channel if polling at scale.

**Implementation sketch (later):**

- Spawn one proxy vessel per tracked remote session; minimal bundled `.craft` or procedural stock build.
- Each update: resolve `bodyName`, convert `lat` / `lon` / altitude + `heading` / `pitch` / `roll`; set world position/rotation; optionally interpolate between samples using `universalTime`.
- Hide or fade if telemetry is older than a threshold.
- Cap concurrent ghosts for performance.

**Explicit non-goals:** Accurate collision, IFR separation, or matching the real part tree—only “traffic” flavor.

---

## 2) Tower tracking screen (web, primary deliverable for controllers)

**Goal:** A **tower-facing** UI (new route or expansion of `/tower`) that lists **active tower sessions** and shows **per-craft status** from stored telemetry—so controllers do not open each session manually.

**Who sees it:** Authenticated users with **tower** role (and optionally admins). Must not expose other users’ data to random clients; reuse existing auth and `GET /v1/session/:sessionId` authorization rules or a dedicated aggregate API.

**What to show per active session (minimum viable):**

| Field | Source (conceptual) | Notes |
|--------|---------------------|--------|
| Session id / short label | Session record | Truncated id + craft name if available |
| Pilot / callsign | Session + profile if present | Display name only |
| Status | `queued` / `assigned` / etc. | Highlight “needs tower” |
| Body | `telemetry.bodyName` | Kerbin, Mun, … |
| Position summary | `lat`, `lon` | Rounded |
| Altitude | `radarAlt` or `aslAlt` | Consistent units |
| Speed / VS | `surfaceSpeed`, `verticalSpeed` | Optional |
| Attitude | `heading`, `pitch`, `roll` | Optional compact |
| Staleness | `updatedAt` vs now or `universalTime` in payload | **Critical** for trust |
| Assigned tower | `assignedTowerUserId` | Who is working the flight |

**UX for ~50 in room vs ~3–4 active:**

- **Default view:** Filter to **“active tower sessions only”** (sessions with status not `closed`, pilot in loop)—matches operational need; aligns with admin list concept in `GET /v1/admin/rooms/tower` (tower staff may need a **non-admin** variant that only lists sessions they may serve).
- **Secondary:** Optional “community / lounge” participant count (voice/chat) **separate** from ATC list—do not mix 50 lounge users into the same table as position reports.
- **Sorting:** “Needs attention” first (queued, stale telemetry, low altitude), then by time.
- **Row limit / pagination:** If the backend later lists many sessions, cap UI rows and warn on stale data.

**Backend gaps to plan (when implementing):**

- **Tower-scoped session list:** Today `GET /v1/admin/rooms/tower` is **admin-only**. Likely need `GET /v1/tower/sessions/active` (or similar) returning **sanitized** rows + latest telemetry for tower role, without full admin powers.
- **Efficiency:** Avoid N+1 `GET /session/:id` from the browser; prefer one aggregate endpoint with last telemetry snapshot per session.
- **Realtime:** Start with **polling every 2–5 s** for MVP; optional **SSE** or WebSocket for telemetry deltas if load requires it.

---

## 3) Phasing (suggested order)

1. **Backend:** Aggregate “active sessions + telemetry snapshot” for tower role; document fields and rate limits.
2. **Web:** Tracking page (table + filters + staleness badges); link from nav on `/tower`.
3. **KSP plugin (optional):** Ghost aircraft following telemetry for observers who also run the game—after web tracking proves the data model.

---

## 4) Related code (ground truth at time of writing)

- Telemetry ingest: `POST /v1/telemetry/:sessionId` (`backend/src/routes/api.ts`).
- Session detail (includes telemetry): `GET /v1/session/:sessionId`.
- Admin operational list: `GET /v1/admin/rooms/tower` (admin-only).
- Web routes: `web/src/App.tsx` (`/tower`, `/admin`, …); `TowerDesk.tsx` is currently queue/dev testing—candidate to embed or link a new **Tracking** view.

---

## 5) Open questions

- **Room definition:** Is “50 in a room” the **LiveKit voice room**, a **chat session**, or a **logical community**? Tracking UI should key off **tower sessions** (`sessionId`), not voice participant count.
- **Privacy:** Whether non-assigned tower users may see all active telemetry or only assigned sessions—product decision.
- **Map:** Optional second phase: 2D map per body (lat/lon plot) using the same aggregate API.

---

*Last updated: 2026-04-09 — planning document only; not yet implemented.*
