# Backend

Express 5 + TypeScript service. Single Node process. All HTTP under `/v1/*`.

Source root: `backend/src/`

## Layout

```
backend/src/
├── index.ts                 # HTTP server bootstrap, live UDP/WS, pilot-idle sweep
├── pilotIdleSessionSweep.ts # Timer: soft-close sessions with stale telemetry (see SETTINGS_REFERENCE)
├── config/
│   └── env.ts               # Zod-validated process.env, prod guards
├── lib/
│   ├── db.ts                # MariaDB pool + migration runner
│   ├── redis.ts             # ioredis client (optional)
│   ├── logger.ts            # Pino instance
│   └── httpRequestLogSilence.ts  # mute pino-http for noisy polling routes
├── middleware/
│   └── auth.ts              # requireAuth, requireRole, requireCapability, IP ban
├── routes/
│   └── api.ts               # All /v1/* endpoints (one big router on purpose)
├── services/
│   ├── repository.ts        # The core: sessions, users, roles, msgs, bans
│   ├── store.ts             # Persistence backend selector (mariadb | redis | memory)
│   ├── webAuth.ts           # WEB_LOGIN_USERS_JSON parsing + tower_web JWT mint
│   ├── pluginAuth.ts        # plugin_session JWT exchange flow
│   ├── guestAuth.ts         # guest JWT mint + IP fingerprint
│   ├── livekit.ts           # LiveKit token mint, room ensure, kick
│   ├── scoring.ts           # Telemetry → score event detection
│   ├── hullcamStore.ts      # In-memory latest-frame-per-camera store
│   ├── hullcamCompress.ts   # Lazy sharp re-encode (mozjpeg + WebP) cached on the frame
│   ├── craftThumbnailStore.ts # Validated saved craft PNGs; bounded in-memory store
│   ├── worldInventory.ts    # Per-session vessel/runway/airfield catalog
│   └── worldMaps.ts         # Static map layers (basemap, navaids)
├── tower/                   # Pure tower rules — see TOWER_LOGIC.md
│   ├── afterTelemetry.ts    # Post-telemetry hooks (violations, sequencing, …)
│   ├── approachQueue.ts
│   ├── separation.ts
│   ├── flightEdges.ts
│   ├── phaseTimeline.ts
│   ├── runwayState.ts
│   ├── landingQuality.ts
│   ├── violations.ts
│   ├── radioState.ts        # Also called from repository.setTelemetry
│   └── telemetryReplyPayload.ts
└── types/
    └── express.d.ts         # `req.auth` augmentation
```

Tower derivation rules (thresholds, flows, implemented vs planned) are documented
in [`TOWER_LOGIC.md`](TOWER_LOGIC.md). Mutation-tested modules: `npm run test:mutation`
from `KSCTowerNetwork-dev/`.

## Bootstrap

`index.ts` does, in order:

1. Loads `.env` and (in non-prod) `.env.development` via `dotenv`, except in test mode or Node test-runner children. `npm test` preloads `backend/test/setup.cjs` for isolated in-memory fixtures and clears LiveKit credentials before imports.
2. Configures `pino-http` with the silence list from `httpRequestLogSilence.ts`
   so high-frequency polls (telemetry, hullcam) don't drown the log.
3. Helmet + CORS. CORS is **explicit allowlist**:
   - `CORS_ORIGINS=https://tower.example.com,https://other.example.com`.
   - Empty `CORS_ORIGINS` in dev defaults to common Vite localhost origins.
   - Empty in prod = no cross-origin browser requests allowed.
   - The `*` wildcard works but disables credentialed CORS automatically.
4. Body parsers (per-route, see `index.ts`):
   - Global JSON parser: `1 mb` limit. Tight on purpose so chat / auth /
     telemetry can't be flooded with megabyte payloads.
   - Heavy JSON routes (`/v1/world-inventory/*` ≤ 4 MB,
     `/v1/world-maps/*` ≤ 8 MB) skip the global parser and mount their own
     bigger ones — keep the `HEAVY_JSON_ROUTE_PREFIXES` list in `index.ts`
     in sync if you add another such route.
   - HullCam (`POST /v1/hullcam/*`) uses `express.raw({ type: "image/jpeg",
     limit: 192 KB })` — see [HullCam pipeline](#hullcam-pipeline) below.
5. Mounts `apiRouter` at `/v1`.
6. `await runMigrations()` (no-op when `DEV_IN_MEMORY` is on).
7. `app.listen(env.PORT)` — the same Node process also runs optional
   local-development **UDP** ingest (`live/udpWorker.ts`, disabled by default),
   **WebSocket** live push (`live/wsTransport.ts`), and
   (unless `PILOT_IDLE_CLOSE_SECONDS=0`) a **`pilotIdleSessionSweep`** timer that
   soft-closes tower sessions when `lastTelemetryAt` is older than that threshold
   (same outcome as lobby **Close**; skips `dev-shared`, `ksc-radio-*`,
   `KSC-TOWER-*`, and sessions that never received telemetry). Tunables:
   [SETTINGS_REFERENCE.md → Telemetry](SETTINGS_REFERENCE.md#telemetry).
   `SIGINT`/`SIGTERM` clear the sweep, live transports, and HTTP server.

## Environment

See [SETTINGS_REFERENCE.md](SETTINGS_REFERENCE.md) for the exhaustive list.
Production guards in `env.ts` will refuse to start when:

- `APP_JWT_SECRET` is still the dev default.
- `DEV_OPEN_AUTH=true`.
- `DEV_BEARER_SECRET` is set.
- `DEV_VOICE_IDENTITY_HEADER` is set.
- `DEV_DEFAULT_WEB_USER=true`.
- `DEV_IN_MEMORY=true`.

These guards exist because each one was a real production foot-gun at some
point in the project. Don't remove them.

## Persistence

`services/store.ts` picks one of three backends at boot:

| Mode | Selector | Use |
|---|---|---|
| **MariaDB + Redis** | DB reachable, `DEV_IN_MEMORY=false`. | Production. Redis is used for ephemeral state (queues, cache); MariaDB for sessions/users/messages/bans. |
| **MariaDB only** | DB reachable, no Redis. | Smaller deployments. Repository falls back to in-process for queues. |
| **In-memory** | `DEV_IN_MEMORY=true`, or DB unreachable in dev. | Local dev. State lost on restart. |

Schema lives in `lib/db.ts` `runMigrations()` — additive only, never drops.
Idempotent: safe to re-run on every boot.

## `services/repository.ts`

The single largest file in the backend (~66 KB). All persistence reads/writes
go through it. **Don't add new persistence code anywhere else** — keep the
"backend swappable" property by funneling everything here.

Domain entities:

- `SessionRecord` — one ATC call/session. Fields include `id`, `pilotUserId`,
  `controllerUserId`, `craftName`, `squawk`, `callsign`, `status`, etc.
- `UserAccess` — `{ role, capabilities, isMuted, muteExpiresAt? }`.
- `MessageRecord` — discriminated by scope: `lobby`, `session`, `dm`.
- `BanRecord` — `{ userId, kind: 'ban'|'mute'|'ip', expiresAt?, reason? }`.

Key invariants enforced here:

- **Owner immunity**: `OWNER_USER_ID` cannot be banned, muted, or demoted.
  `isOwnerImmuneId()` is the single source of truth.
- **Role rank**: `ROLE_RANK` and `roleAtLeast()` are always used for
  comparisons — never compare roles by string equality outside this file.
- **Capabilities are derived from role**, not stored per-user:
  `capabilitiesFor(role)`. To grant a one-off cap, mint a different role.

## `services/livekit.ts`

- `isLiveKitConfigured()` checks `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  and a non-placeholder `LIVEKIT_WS_URL`/`LIVEKIT_URL`.
- `ensureLiveKitRoom(name)` creates the room idempotently via the LiveKit
  Server SDK so participants don't race to create on first join.
- `issueLiveKitToken({ room, identity, name, canPublish })` mints a JWT.
  - The voice bridge identity (`LIVEKIT_BRIDGE_IDENTITIES`, default
    `ksp_bridge`) gets `canPublish=false` (subscribe-only) and a clean
    display name (`LIVEKIT_BRIDGE_DISPLAY_NAME`).
  - Web tower/pilot get full publish.
- `revokePublishForIdentity` and `kickIdentityFromAllRooms` are mod
  operations.

## HullCam pipeline

End-to-end flow for the JRTI → backend → tower JPEG relay. Two modules cooperate:
`services/hullcamStore.ts` (plain in-memory data + caps) and
`services/hullcamCompress.ts` (lazy sharp re-encode). Routes live in
`routes/api.ts`, search for `/hullcam/`.

### Transport stack (what is and is not "HTTP")

| Leg | Protocol | Notes |
|---|---|---|
| JRTI ↔ KSP plugin | **HTTP** to `127.0.0.1` (configurable host/port) | Third-party mod API (`/cameras`, `/camera/{id}/snapshot`). No TLS; traffic stays on the pilot PC. |
| KSP plugin ↔ tower API | **Same as `ApiBaseUrl`** | Typically `http://` against a dev backend or `https://` in production — not HullCam-specific. |
| Browser ↔ tower API | **HTTPS or HTTP** per how the SPA is deployed | `HullCamPanel` builds URLs from `getApiBase()` + `/v1/hullcam/...`. List + snapshot use **GET with `Authorization: Bearer`** so we cannot use a dumb `<img src="https://…">` without exposing the token. |
| Live WebSocket / UDP | **Not used for JPEG pixels** | Meta/presence may subscribe over the live channel, but each frame is still pulled via `GET snapshot.jpg` today. |

### Limits at every hop

| Hop | Limit | Where | Why |
|---|---|---|---|
| Plugin → backend body size | **192 KB** per frame | `HULLCAM_MAX_BODY_BYTES` in `routes/api.ts`, enforced by `express.raw({ type: "image/jpeg", limit })` | JRTI's typical 1280×720 q75 frame is 30–80 KB. 192 KB covers a generous q95 frame; anything larger is misconfigured JRTI or a malicious client. Wrong content-type → empty body → 400. |
| Plugin → backend rate | **5 frames/sec/user** | `hullcamLimiter` in `middleware/rateLimit.ts` | Plugin defaults to 1 fps, clamps at 2 fps. Server cap is the worst-case ceiling we're prepared to spend per attacker. Worst-case ingress per attacker: 5 × 192 KB = 960 KB/s. |
| Plugin → backend content | **JPEG SOI (0xFF 0xD8)** | `routes/api.ts` after the raw parser | Stops anything that obviously isn't a JPEG from being served back to the tower's `<img>`. |
| Camera name | **64 chars after sanitization** | `routes/api.ts`, raw header capped at 256 chars before `decodeURIComponent`, then C0/C1 control chars and bidi-override codepoints (`U+202A..U+202E`, `U+2066..U+2069`) stripped | React already escapes HTML so XSS is moot; this is about log integrity and any future non-React renderer. |
| Cameras per session | **8** (matches JRTI's `MaxOpenCameras`) | `MAX_CAMERAS_PER_SESSION` in `hullcamStore.ts` | New camera ids past the cap are dropped; updates to already-tracked ids always succeed so a misbehaving pilot can't lock a real session out. |
| Sessions in store | **128** | `MAX_SESSIONS` in `hullcamStore.ts` | Eagerly enforced inside `putFrame` (oldest-first eviction), not just lazily by the 30 s sweeper. Worst-case memory: 128 × 8 × 192 KB ≈ 192 MB. |
| Frame staleness | **10 s** | `STALE_MS` in `hullcamStore.ts` | `getFrame` returns null past this; `GET /snapshot.jpg` then responds `503 {reason: "los"}` so the UI distinguishes "lost feed" from "no such session". Sweeper drops stale frames every 30 s. |
| Authorization | Pilot of session, **except** `KSC-TOWER-*` namespace | `routes/api.ts` | The `KSC-TOWER-*` namespace is intentionally session-rowless and writable by any signed-in user — it's the "look out the tower window" feed (see [GHOSTS_AND_TOWER_VIEW_PLAN.md](../GHOSTS_AND_TOWER_VIEW_PLAN.md)). The plugin namespaces by SHA-1 of the user's email so two users don't collide. |

### Egress: lazy re-encode + cache

The pilot uploads at 1 fps but every viewer polls at 1 fps too, so egress = N viewers × ingress. `services/hullcamCompress.ts` re-encodes once per frame and caches the result on the `HullCamFrame` itself.

- **First viewer GET on a fresh frame** → one sharp call (~5–15 ms), result cached on the frame.
- **Concurrent viewers GET the same frame** → all share the in-flight `Promise` (`webpPromise` / `optimizedJpegPromise`), one encode total per frame.
- **Subsequent polls** → cache hit until the pilot uploads a new frame; the new `HullCamFrame` object has empty cache fields and the cycle restarts.
- **No viewers** → 0% extra CPU, frames sit in the store unencoded.
- **sharp throws** → `optimizationFailed` flag set on the frame, original bytes are served. The next frame retries from scratch.

### Capacity planning — CPU, bandwidth, and RAM

**Does HullCam hurt my server?** It can add measurable load, but the design caps the worst case and avoids work when nobody is watching.

| Resource | What drives it | Mitigations already in code |
|---|---|---|
| **CPU** | `sharp` resize + mozjpeg/WebP on the **first** `GET snapshot.jpg` for each new frame; concurrent viewers share one in-flight encode. | Cached per frame until the pilot posts a newer JPEG. **If nobody GETs**, no re-encode CPU — the store only holds raw bytes. |
| **Bandwidth (ingress)** | Pilot `POST` cadence × frame size × number of cameras. | Plugin defaults **1 fps** (max **2**); server **`hullcamLimiter`** caps at **5 POST/s per user**; body **`≤ 192 KB`** per frame (`express.raw` limit). |
| **Bandwidth (egress)** | Each tower browser polls **~1 Hz per tile**; N viewers × M cameras multiplies bytes out. | Egress is much smaller than raw JRTI thanks to **downscale + WebP/JPEG cache** (see table above). First viewer pays the encode; others hit the cache. |
| **RAM** | One latest frame per `(sessionId, cameraId)` in memory. | **`MAX_CAMERAS_PER_SESSION`** (8) × **`MAX_SESSIONS`** (128) × **192 KB** theoretical ceiling ≈ **192 MB** if every slot were full-sized — a defensive upper bound, not a typical steady state. Stale frames are swept. |

**Practical expectation:** a single pilot with one camera at ~1 fps and a few controllers is modest compared to voice or heavy telemetry; many simultaneous viewers on the same camera chiefly cost **egress bandwidth** and **poll QPS**, not unbounded RAM.

Variants and tunables (top of `hullcamCompress.ts`):

| Tunable | Default | Notes |
|---|---|---|
| `TARGET_WIDTH_PX` | `960` | Largest tile size the SPA actually renders. Larger inputs are downscaled, smaller ones are left alone (`withoutEnlargement: true`). |
| `JPEG_QUALITY` | `78` | mozjpeg quality. Visually indistinguishable from JRTI default, ~50% smaller. |
| `WEBP_QUALITY` | `72` | WebP at 72 ≈ JPEG at 80 quality, ~25–35% smaller again. |

### Content negotiation

`GET /v1/hullcam/:sessionId/:cameraId/snapshot.jpg` returns:

- `image/webp` when the request `Accept` header includes `image/webp` (every modern browser does this transparently for `<img>` tags).
- `image/jpeg` (downscaled mozjpeg variant) otherwise.
- The raw JRTI bytes as a fallback if both encoders fail.

Response headers:

| Header | Purpose |
|---|---|
| `Vary: Accept` | Critical if you put a CDN in front — without this, a webp byte stream might be cached and served to a jpeg-only client. |
| `Cache-Control: no-store, max-age=0` | Frames change at 1 Hz; never cache. |
| `X-Frame-Age-Ms` | `Date.now() - frame.updatedAtMs`. Surfaced to the UI so it can render an "age" indicator. |
| `X-Frame-Bytes-Orig` | Raw bytes the pilot posted. Compare to `Content-Length` in DevTools to eyeball the savings. |

### Verifying the pipeline

Quick end-to-end smoke test you can run against a local dev backend (port
`48787`, `DEV_OPEN_AUTH=true`) — POSTs a synthetic 1280×720 JPEG, then GETs
it back twice with different `Accept` headers to exercise both encode paths
plus the in-memory cache hit:

```bash
node -e "
const http = require('http');
const sharp = require('sharp');
function req(path, method, body, headers) {
  return new Promise(r => {
    const q = http.request({ hostname:'127.0.0.1', port:48787, path, method,
      headers: { ...headers, Authorization:'Bearer dev-bypass' } }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => r({ status:res.statusCode, ct:res.headers['content-type'],
        vary:res.headers.vary, age:res.headers['x-frame-age-ms'],
        orig:res.headers['x-frame-bytes-orig'],
        bytes:Buffer.concat(c).length,
        sig:Buffer.concat(c).slice(0,4).toString('hex') }));
    });
    if (body) q.write(body);
    q.end();
  });
}
(async () => {
  const jpeg = await sharp({create:{width:1280,height:720,channels:3,
    background:{r:80,g:120,b:60}}}).jpeg({quality:75}).toBuffer();
  console.log('orig JPEG:', jpeg.length, 'bytes');
  console.log('POST:', await req('/v1/hullcam/dev-shared/777', 'POST', jpeg,
    { 'Content-Type':'image/jpeg','Content-Length':jpeg.length,
      'X-Camera-Name':'SmokeTest' }));
  console.log('GET (webp):', await req('/v1/hullcam/dev-shared/777/snapshot.jpg',
    'GET', null, { Accept:'image/webp,image/*' }));
  console.log('GET (jpeg):', await req('/v1/hullcam/dev-shared/777/snapshot.jpg',
    'GET', null, { Accept:'image/jpeg' }));
  console.log('GET (cache):', await req('/v1/hullcam/dev-shared/777/snapshot.jpg',
    'GET', null, { Accept:'image/webp' }));
})();"
```

Expected:

| Call | Status | `Content-Type` | First 4 bytes | Notes |
|---|---|---|---|---|
| POST | 200 | `application/json` | `{"ok` (`7b226f6b`) | `nextFrameMs: 1000` in body |
| GET (webp) | 200 | `image/webp` | `RIFF` (`52494646`) | Vary: Accept, X-Frame-Bytes-Orig matches POST size |
| GET (jpeg) | 200 | `image/jpeg` | JPEG SOI (`ffd8…`) | Different size from webp call |
| GET (cache) | 200 | `image/webp` | `RIFF` | Identical bytes to first webp call (cache hit) |

Sanity numbers from a clean run against the synthetic frame: 5669-byte
input → 1004-byte WebP (~82% smaller) → 1856-byte mozjpeg (~67% smaller).
Real JRTI frames have actual detail and won't compress quite this well —
expect ~50–60% reduction, matching the variants table above.

### When things go wrong

- **Sharp / libvips broken on a host (rare on Linux/Windows, common on niche CPU archs)**: the encode catches the exception, sets `optimizationFailed`, logs once via `logger.warn`, and serves the original bytes. The relay keeps working, just at full bandwidth.
- **Plugin sending oversized frames**: 413 from express.raw before the route handler runs. Plugin should respect its own `HullCamMaxBytes` (default 192 KB, max 512 KB in `settings.cfg`) but the server clamp is the real defense.
- **Plugin sending non-JPEG bytes with `Content-Type: image/jpeg`**: `express.raw` will accept the body, the SOI marker check rejects it with 400.
- **Plugin sending JPEG with wrong `Content-Type`**: `express.raw` skips it, body comes through as `{}` from the upstream parser, the `Buffer.isBuffer && length > 0` check rejects with 400.
- **An attacker spamming the `KSC-TOWER-*` namespace under their own auth**: rate-limited to 5 fps/user; their stream id is determined by SHA-1 of their email so they can't overwrite somebody else's tower view. Worst they can do is fill 8 cameras under their own id.

## Authentication middleware

`middleware/auth.ts` exports the four helpers used by every protected route:

| Middleware | Behavior |
|---|---|
| `loadIpBan` | Checks IP against ban table. Mounted globally before any auth. |
| `requireAuth` | Verifies bearer; sets `req.auth = { userId, tokenType, ip, displayName?, email? }`. Falls back through dev-open / dev-bearer / Clerk in that order. |
| `requireRole(min)` | 403 if `effectiveRole(req) < min`. |
| `requireCapability(cap)` | 403 if `cap` not in `capabilitiesFor(role)`. |

**Token type → identity mapping** is in [AUTH_AND_ROLES.md](AUTH_AND_ROLES.md).

## Routes

`routes/api.ts` is intentionally one file (~58 KB). Reasons:

- Easier to scan the full surface in one pass.
- Easier to enforce that every route has `requireAuth` (or an explicit
  comment for the few that don't, e.g. `/health`, `/auth/login`).
- Avoids a folder of tiny routers each with their own middleware boilerplate.

When you add a route:

1. Define a Zod schema near the top of the file (or beside the handler if
   only used once).
2. Pick the right gate: `requireAuth` + (one of) `requireRole` /
   `requireCapability`.
3. Touch `repository.ts`, not `db.ts`/`redis.ts` directly.
4. If you change the request/response shape, update
   [API_REFERENCE.md](API_REFERENCE.md).

## Logging

- Pino + pino-http. JSON in prod, pretty in dev.
- `httpRequestLogSilence.ts` mutes:
  - `POST /v1/telemetry/*`
  - `POST /v1/hullcam/*/snapshot.jpg`
  - `GET /v1/hullcam/*/snapshot.jpg`
  - `GET /v1/session/*/messages` and similar polling reads.
  Otherwise these would be most of the log volume.
- Errors always log full stack. Don't `console.log`; use `logger.error`.

## Adding a migration

`lib/db.ts` has a single `runMigrations()` function with sequential numbered
migrations:

```ts
async function runMigrations() {
  await migrate(1, "create users table",      "CREATE TABLE IF NOT EXISTS …");
  await migrate(2, "create sessions table",   "…");
  // …
}
```

Append-only. Never reuse a number. Never alter a previously applied SQL —
write a new migration that does the alter.

## Telemetry-driven adaptive intervals

`POST /v1/telemetry/{sessionId}` returns a `nextTelemetrySeconds`. The
plugin obeys it. Backend logic (in `routes/api.ts`):

- Default: `TELEMETRY_DEFAULT_SECONDS` (5).
- Within `TELEMETRY_CLOSE_AGL_M` (15 km AGL) or moving fast on the runway:
  `TELEMETRY_CLOSE_SECONDS` (1).

Tweak via env when running on slow links.

## Craft thumbnails

`POST /v1/craft-thumbnail/:sessionId` accepts a pilot-only `image/png` body
(maximum 256 KiB) with URL-encoded `x-craft-name`. The session must be open
and the name must match current telemetry. Sharp decodes with a four-million
pixel limit, bounds the image to 960 by 540 without upscaling, preserves
transparency, and refuses normalized PNGs over 256 KiB. The craft name is
checked again after decoding in case the pilot switched craft. The existing
heavy-publish limiter applies.

`GET /v1/craft-thumbnail/:sessionId?craftName=...` permits controllers to read
radar craft photos; pilots/spectators need session membership. Banned users
are rejected. The requested, stored and active telemetry names must match.
Closed sessions and missing/expired images return 404. Success returns PNG
with `Cache-Control: private, no-store`. No arbitrary image URL or local
filesystem path is accepted. Storage is process-local, capped at 128 sessions
(32 MiB of PNG bytes), with five-minute expiration and oldest-entry eviction.
The plugin's minute refresh restores images after backend restarts.
