# HTTP API Reference

Base path: `/v1`. All bodies JSON unless noted. Bearer token via the
`Authorization: Bearer <token>` header.

> Generated against `backend/src/routes/api.ts`. Update this file when you
> add or change a route. Schemas are at the top of `api.ts`; consult them
> for exact field validation.

## Auth gates legend

| Tag | Meaning |
|---|---|
| `[public]` | No auth (still IP-banned). |
| `[auth]` | `requireAuth` only. |
| `[role:X]` | Requires role `X` or higher (`pilot < controller < mod < supermod < owner`). |
| `[cap:Y]` | Requires capability `Y` (see [AUTH_AND_ROLES.md](AUTH_AND_ROLES.md)). |

## Health & meta

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/health` | `[public]` | `{ ok: true }`. Use for load-balancer probes. |
| `GET` | `/auth/me` | `[auth]` | Effective identity, role, capabilities. |

## Authentication

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/auth/login` | `[public]` | `{ email, password, callsign? or displayName? }` (same field) → `{ token, user }`. Issues `tower_web` JWT. |
| `POST` | `/auth/guest` | `[public]` | `{}` → `{ token, user }`. Issues `guest` JWT. IP fingerprint stored for IP-ban. |
| `POST` | `/auth/plugin/exchange` | `[public]` | `{ code }` → `{ token }`. Redeems a 1-time code minted by an authenticated web user; returns long-lived `plugin_session` JWT. |

## Sessions / queue

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/queue/join` | `[auth]` | Optional `{ kind?: "tower" }`. Pilot joins the wait-for-controller queue. |
| `POST` | `/queue/leave` | `[auth]` | Removes caller from the queue. |
| `POST` | `/session/call` | `[cap:plugin:use]` | `{ kind:"tower", craftName? }` → creates a session and returns the assigned controller (if any). |
| `GET` | `/session/:sessionId` | `[auth]` | Full `SessionRecord`. Returns 404 unless caller is participant, spectator, or admin, for every token type. |
| `POST` | `/session/claim-pilot` | `[cap:plugin:use]` | `{ sessionId? or frequencyMhz?, name? }`. Requires a `plugin_session` token; tower web JWTs cannot claim a pilot seat. |
| `POST` | `/session/:sessionId/next-tower` | `[auth]` | Re-roll controller assignment (skip current). Tower-side. |
| `POST` | `/session/:sessionId/block` | `[auth]` | Block another user from the caller's future sessions. |
| `GET` | `/session/:sessionId/scorecard` | `[auth]` | Computed score events for the session. |
| `POST` | `/session/:sessionId/clearance` | `[cap:controller:assume]` | `{ clearance: TAKEOFF\|LANDING\|TAXI\|HOLD_SHORT\|GO_AROUND, status: cleared\|violation\|neutral }`. Persists `clearances_json`. |
| `POST` | `/session/:sessionId/expected-runway` | `[cap:controller:assume]` | `{ runway: string \| null }` — optional expected landing runway for wrong-runway RP checks. |
| `POST` | `/session/:sessionId/runway-occupancy` | `[cap:controller:assume]` | `{ bodyName, runwayId, occupied: boolean }` — manual runway occupancy override (in-memory). |
| `POST` | `/session/:sessionId/countdown/request` | `[cap:chat:session]` | Pilot ping: `{ kind?: "launch" \| "takeoff" }` — sets ephemeral `countdownRequest` or `takeoffRequest` (mutually exclusive) + session chat line. Throttled. |
| `POST` | `/session/:sessionId/countdown/start` | `[cap:controller:assume]` | `{ seconds }` — starts synced countdown; clears pending markers. |
| `POST` | `/session/:sessionId/countdown/scrub` | `[cap:controller:assume]` | Clears active countdown clock + pending launch marker. |
| `POST` | `/session/:sessionId/countdown/post-liftoff-abort` | `[cap:chat:session]` | Within **60 s** after nominal T-0; clears countdown (same scrub path) + chat line. |
| `POST` | `/session/:sessionId/pilot-pending/handle` | `[cap:controller:assume]` | `{ target: "takeoff" \| "launch", action: "grant" \| "dismiss" }` — takeoff: grant (posts `[CLEARANCE]`) or dismiss; launch: **dismiss** only (grant launch → **400**, use **countdown/start**). `{ ok, changed }` when nothing to do. |

## Messaging

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/session/:sessionId/messages` | `[auth]` | Participant or admin. |
| `POST` | `/session/:sessionId/messages` | `[cap:chat:session]` | `{ text }`. Mute-checked. |
| `GET` | `/lobby/messages` | `[auth]` | |
| `POST` | `/lobby/messages` | `[cap:chat:lobby]` | `{ text }`. Mute-checked. |
| `GET` | `/lobby/rooms` | `[auth]` | List of currently active sessions. |
| `GET` | `/dm/peers` | `[cap:chat:dm]` | People you may DM. |
| `GET` | `/dm/threads` | `[cap:chat:dm]` | Conversation summaries. |
| `GET` | `/dm/messages` | `[cap:chat:dm]` | `?with=<userId>`. |
| `POST` | `/dm/messages` | `[cap:chat:dm]` | `{ to, text }`. Mute-checked. |

## Telemetry & in-world data

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/telemetry/:sessionId` | `[auth]` | Body matches `telemetrySchema` (lat/lon/alt/speed/attitude/flags/biome/etc.). Returns `{ ok, nextTelemetrySeconds, serverNowMs, countdown?, takeoffClearanceAtMs?, clearances?, recentViolations?, phaseTimeline?, approachSequence?, lastLandingQuality? }` — `takeoffClearanceAtMs` is epoch ms of the last tower takeoff grant (plugin shows **APPROVED** for 10 s). Same fields on local-development UDP `reply.ok`. |
| `GET` | `/world-inventory/:sessionId` | `[auth]` | Last published inventory for the session. |
| `POST` | `/world-inventory/:sessionId` | `[auth]` | Plugin pushes vessel/runway/airfield catalog (matches `worldInventorySchema`). |
| `GET` | `/world-maps/:sessionId` | `[auth]` | Layer index. |
| `GET` | `/world-maps/:sessionId/layer/:layerId` | `[auth]` | Layer payload (basemap tile, etc.). |
| `POST` | `/world-maps/:sessionId/...` | `[auth]` | Plugin uploads a baked basemap layer. |

## Live transport & tower awareness

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/tower/active-aircraft` | `[auth]` | Ghost-fleet roster (`TowerGhostFleet`); same logical data as the live WebSocket `tower.active-aircraft` snapshot. Adds `separationConflicts`, `runwayOccupancy`, per-row `approachSequence` / `phaseTimeline` / `recentViolations` when available. Authenticated plugin clients use this GET over HTTPS. |
| `GET` | `/tower/view-streams` | `[auth]` | Live `KSC-TOWER-*` hullcam stream ids for the Tower View tile. |
| `GET` | `/live/metrics` | `[role:mod]` | In-process counters for UDP, WS, snapshot builds, selected HTTP hot paths — see [PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md). |

WebSocket upgrades use **`LIVE_WS_PATH`** on the same HTTP server (default `/v1/live/ws`); query params carry `token` + `sessionId`. See [ARCHITECTURE.md](ARCHITECTURE.md#ports-firewall-and-live-transport).

## HullCam

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/hullcam/:sessionId` | `[auth]` | Camera summaries: `[{id, name, updatedAtMs, snapshotUrl}, …]` plus `serverNowMs` and `staleMs` so the client can compute LOS itself (frames older than `staleMs` are filtered out server-side). |
| `GET` | `/hullcam/:sessionId/:cameraId/snapshot.jpg` | `[auth]` | Latest frame. **Content-negotiated**: returns `image/webp` when the client's `Accept` header includes it (downscaled to ≤960 px wide, q72 → ~60% smaller than the original), otherwise `image/jpeg` (downscaled, mozjpeg q78). Original JRTI bytes are returned as a fallback if re-encode fails. Response carries `Vary: Accept`, `X-Frame-Age-Ms`, `X-Frame-Bytes-Orig` (raw bytes posted by the pilot). `503 {reason: "los"}` when no fresh frame exists. |
| `POST` | `/hullcam/:sessionId/:cameraId` | `[auth]` + `hullcamLimiter` (5 fps/user) | Raw JPEG body. Pilot's plugin uploads. Body must be `Content-Type: image/jpeg`, ≤192 KB, start with `0xFF 0xD8` (JPEG SOI). Optional `X-Camera-Name` header (URL-encoded, ≤64 chars after sanitization). For non-`KSC-TOWER-*` session ids, only the session's pilot may publish. |

`snapshotUrl` in the list response is a **path** (`/v1/hullcam/.../snapshot.jpg`), not an absolute URL — the browser uses the SPA's configured API origin. **Transport / CPU / bandwidth / RAM:** see [BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline) (including *Transport stack* and *Capacity planning*).

## Voice

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/session/:sessionId/livekit-token` | `[auth]` | Mints a LiveKit room JWT for the caller's identity. The voice bridge identity gets `canPublish=false` and a clean display name. |

## Profile

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/users/:userId/profile` | `[auth]` | Public profile. |
| `POST` | `/profile/...` | `[auth]` | Profile edits (callsign, etc.). |

## Reports & moderation

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/report` | `[auth]` | `{ targetUserId?, sessionId?, reason }`. |
| `GET` | `/admin/reports` | `[role:mod]` | |
| `POST` | `/admin/ban` | `[role:mod]` | `{ userId, durationSeconds?, reason? }`. Permanent ban needs `supermod+`. |
| `POST` | `/admin/mute` | `[role:mod]` | `{ userId, durationSeconds, reason? }`. |
| `POST` | `/admin/ban-ip` | `[role:mod]` | `{ guestId, durationSeconds?, reason? }`. Permanent IP ban needs `supermod+`. |
| `POST` | `/admin/role` | `[role:owner]` | `{ userId, role }`. Owner role excluded — only `OWNER_USER_ID` env grants owner. |
| `GET` | `/admin/logs` | `[role:mod]` | Action log. |
| `GET` | `/admin/bans` | `[role:mod]` | Active bans + mutes. |
| `GET` | `/admin/rooms/tower` | `[role:mod]` | Active tower rooms. |
| `GET` | `/admin/rooms/chat` | `[role:mod]` | Active chat surfaces. |

## LiveKit moderation actions (in `/admin/...` block)

These also live in `api.ts` near the moderation endpoints:

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/admin/livekit/revoke-publish` | `[role:mod]` | Revokes publish permission for an identity in a room. |
| `POST` | `/admin/livekit/kick` | `[role:mod]` | Kicks an identity from all rooms. |

> **Update this file** when you add a route. The full source of truth is
> `backend/src/routes/api.ts`. Run `rg "apiRouter\.(get|post|put|patch|delete)" backend/src/routes/api.ts`
> to regenerate the list quickly.

## Saved craft thumbnails

All paths below have the `/v1` prefix.

| Method | Path | Gate | Notes |
|---|---|---|---|
| `POST` | `/craft-thumbnail/:sessionId` | `[auth]`, session pilot only | Raw `image/png` <=256 KiB; URL-encoded `x-craft-name` must match active telemetry. Open sessions only; heavy-publish limiter; validated and downscaled to <=960 by 540. Returns `{ ok: true }`. Invalid image/name: 400; non-pilot: 403; craft mismatch: 409; oversize: 413. |
| `GET` | `/craft-thumbnail/:sessionId?craftName=...` | controller+ or session member/admin; bans enforced | PNG of matching current saved craft; `private, no-store`. Missing/expired/mismatched image or closed session: 404. Five-minute TTL, 128-session process-local cap. |

`GET /tower/active-aircraft` also includes optional `targetRunway` and
`telemetryHealthState` alongside `lastTelemetryAt`; Flightwall uses server
receipt time and health (including beacon-off/pause) for freshness.
