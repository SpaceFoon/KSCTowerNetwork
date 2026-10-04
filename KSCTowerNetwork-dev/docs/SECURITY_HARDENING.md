# Security Hardening — 2026-04-17

Tracks the security work landed across `backend/`, `web/`, and
`KSCTowerNetwork-voice-bridge/` in a single sweep. Each item lists the
threat model, the fix, the files touched, and any operator-visible
config or behaviour change.

The audit that drove this work flagged 17 issues across HIGH / MEDIUM /
LOW severity. All 17 are addressed below; the KSP plugin wire protocol
(Bearer token + JSON) is unchanged, so the existing
`KSCTowerNetwork.Client.dll` keeps working without a rebuild.

---

## HIGH

### H1. Stored XSS via world-maps SVG → controller account takeover

- **Threat.** Any `pilot+` could `POST /v1/world-maps/:sessionId` with a
  crafted SVG containing `<script>` or `onload=` handlers. The backend
  served those bytes verbatim with `Content-Type: image/svg+xml`, and
  `web/src/pages/TowerDesk.tsx` inlined the response via
  `dangerouslySetInnerHTML`. A malicious pilot could exfiltrate
  `localStorage.ksc_tower_bearer` from any controller who opened the
  session — full account takeover.
- **Fix.** New `sanitizeSvgBytes()` in
  `backend/src/services/worldMaps.ts` runs DOMPurify (SVG profile + SVG
  filters) on every uploaded layer before persistence. The forbid lists
  block `<script>`, `<foreignObject>`, `<use>`, `<a>`, `href` /
  `xlink:href`, every `on*` handler, and `formaction` / `action`. A
  belt-and-braces regex rejects any leftover `javascript:` URI. If
  DOMPurify removes anything we throw `UnsafeSvgError`, which the route
  handler converts to `400 {reason: "unsafe_svg"}` so a hostile or
  malformed plugin gets a loud rejection instead of a silently stripped
  basemap.
- **Files.** `backend/src/services/worldMaps.ts`,
  `backend/src/routes/api.ts` (route 400 wiring).
- **Deps.** `dompurify`, `jsdom`, `@types/jsdom`.

### H2. No rate limiting anywhere → brute force / spam / OOM

- **Threat.** `/v1/auth/login`, `/v1/auth/guest`, chat endpoints,
  telemetry and HullCam ingest, world-maps and world-inventory publish,
  and plugin exchange-code mint were all unmetered. An attacker could
  brute-force passwords, flood chat, or grow the in-memory message
  buffer until the box OOMs.
- **Fix.** New `backend/src/middleware/rateLimit.ts` exposes six
  buckets with sensible per-route limits:

  | Limiter             | Window | Limit | Key       | Routes                                     |
  | ------------------- | ------ | ----- | --------- | ------------------------------------------ |
  | `authLimiter`       | 60s    | 10    | IP        | `/auth/login`, `/auth/guest`, `/auth/plugin/exchange` |
  | `writeLimiter`      | 10s    | 30    | userId/IP | session/lobby/dm messages, preview-event, report |
  | `telemetryLimiter`  | 1s     | 15    | userId/IP | `/telemetry/:sessionId`                    |
  | `hullcamLimiter`    | 1s     | 5     | userId/IP | `/hullcam/:sessionId/:cameraId`            |
  | `heavyPublishLimiter` | 60s  | 6     | userId/IP | `/world-inventory/:sessionId`, `/world-maps/:sessionId` |
  | `pluginExchangeLimiter` | 60s | 6   | userId/IP | `/auth/plugin/exchange-code`               |

  The store is Redis-backed when `getRedis()` is reachable (counters
  shared across instances) and falls back to per-process memory with a
  one-time warning otherwise. The handler returns
  `429 {reason: "rate_limited", retryAfterSeconds}`.
- **Memory caps.** Two unbounded `Map`s are now LRU/FIFO-trimmed:
  - `localSessionMessages` per session: `SESSION_MESSAGE_MEMORY_CAP =
    1000`. Older messages are spliced out; the DB still holds the full
    archive when persistence is on.
  - `localGuests`: `LOCAL_GUEST_CAP = 10_000`. Oldest insertion-order
    entry is evicted when the cap is hit.
- **Files.** `backend/src/middleware/rateLimit.ts`,
  `backend/src/routes/api.ts`,
  `backend/src/services/repository.ts`.
- **Deps.** `express-rate-limit`, `rate-limit-redis`.

---

## MEDIUM

### M1. Plaintext passwords in `WEB_LOGIN_USERS_JSON`

- **Threat.** `webAuth.ts` accepted only `password: "<plaintext>"`,
  meaning the operator's deployment env, backups, and CI logs all
  contained reversible credentials.
- **Fix.** `credentialForEmail()` now prefers a `passwordHash` field
  (argon2id PHC string starting with `$argon2id$...`). When only the
  legacy `password` field is present we still authenticate but emit a
  one-time `logger.warn` per email pointing at the migration command:
  `node -e "import('argon2').then(a=>a.hash('YOUR_PASSWORD',{type:a.argon2id}).then(console.log))"`.
  `authenticateWebUser()` is now `async` and uses `argon2.verify()`.
  When the email is unknown we also run a dummy verify so the
  per-request CPU cost is constant — defends against email enumeration
  via timing.
- **Files.** `backend/src/services/webAuth.ts`,
  `backend/src/routes/api.ts` (await the new async signature).
- **Deps.** `argon2`.

### M2. JWT in `localStorage` → XSS = total takeover; no CSRF

- **Threat.** Even with H1 fixed, any future XSS in the SPA could read
  `localStorage.ksc_tower_bearer`. There was also no CSRF protection
  for any cookie-style auth that might be added later.
- **Fix (M2a — HttpOnly cookie + double-submit CSRF).**
  - `POST /v1/auth/login` now sets two cookies in addition to returning
    the token in the body (back-compat): `ksc_tower_session` (the JWT,
    HttpOnly, SameSite=Lax, `Secure` in production) and
    `ksc_tower_csrf` (random 32 bytes, NOT HttpOnly so JS can echo it
    in a header). Body still contains `token` and `csrfToken` for any
    legacy localStorage-based clients.
  - New `POST /v1/auth/logout` clears both cookies and writes an audit
    log entry.
  - New `GET /v1/auth/csrf` rotates the CSRF token cookie. The SPA
    calls it once on startup and on demand.
  - `requireAuth` resolves the credential from either the
    `Authorization: Bearer ...` header (KSP plugin, voice bridge, dev
    tooling) or the session cookie (web SPA), and stamps
    `req.auth.authSource` accordingly.
  - New `csrfGuard` middleware in `backend/src/middleware/csrf.ts` is
    mounted globally on the API router. It only enforces on
    state-changing methods (POST/PUT/PATCH/DELETE) AND only when
    `req.auth.authSource === "cookie"`. Bearer-auth requests are
    untouched (the browser doesn't auto-attach `Authorization`, so they
    aren't CSRF-able).
  - The `DEV_BEARER_SECRET` short-circuit is restricted to bearer-auth
    only — refusing a cookie-presented dev secret blocks one
    cross-site fixation pattern.
  - `web/src/api/client.ts` switches to `credentials: "include"`,
    auto-bootstraps the CSRF token (deduplicated promise so a burst of
    POSTs only triggers one `/v1/auth/csrf` round-trip), and attaches
    `X-CSRF-Token` on every mutation. The Bearer header is still sent
    when a token is present so old localStorage sessions and the
    plugin path keep working.
  - `web/src/auth/session.ts` `clearStoredSession()` is now async and
    calls `/v1/auth/logout` best-effort before wiping localStorage.
- **Fix (M2b — CSP).**
  - `web/index.html` ships a strict
    `<meta http-equiv="Content-Security-Policy">` (no inline scripts,
    no eval, `frame-ancestors 'none'`, `object-src 'none'`).
  - `web/vite.config.ts` adds a `securityHeadersPlugin` that also
    emits `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
    `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a
    `Permissions-Policy` granting only `microphone=(self)`, on every
    dev and preview response.
  - `backend/src/index.ts` tightens `helmet()` with
    `defaultSrc: ['none']` (the API never serves HTML, so the safest
    CSP is to forbid everything except the SVG basemap which is loaded
    via `'self'`).
- **Files.** `backend/src/middleware/csrf.ts`,
  `backend/src/middleware/auth.ts`,
  `backend/src/routes/api.ts`,
  `backend/src/types/express.d.ts` (added `authSource`),
  `backend/src/index.ts`,
  `web/src/api/client.ts`,
  `web/src/auth/session.ts`,
  `web/src/App.tsx`,
  `web/index.html`,
  `web/vite.config.ts`.
- **Deps.** `cookie-parser`, `@types/cookie-parser`.
- **Operator note.** Cookies are `Secure` in production, so the SPA
  must be served over HTTPS. Behind a reverse proxy make sure
  `X-Forwarded-Proto: https` reaches Express (combined with the new
  `TRUST_PROXY` setting, see L1).

### M3. Long-lived guest JWT survives server-side guest deletion

- **Threat.** Guest tokens have a 12-hour TTL and were validated solely
  by JWT signature. If a mod deleted the guests row (or the row was
  evicted from `localGuests`), the cached token kept working until
  expiry.
- **Fix.** The guest branch of `requireAuth` now calls
  `getGuestById(appPayload.sub)` and returns
  `401 {reason: "guest_revoked"}` when the row no longer exists. This
  closes the band-aid window between an IP ban and the natural token
  expiry.
- **Files.** `backend/src/middleware/auth.ts`.

### M4. `telemetrySchema` accepts non-finite numbers

- **Threat.** `z.number()` accepts `Infinity`, `-Infinity`, and `NaN`.
  A poisoned telemetry packet could break scoring math, the close-
  approach cadence, and `JSON.stringify` (NaN serialises to `null`,
  silently corrupting downstream consumers).
- **Fix.** Helpers `finiteNum()` / `finiteInt()` enforce
  `.finite()`. Bounded ranges added where they make physical sense
  (`lat ±90`, `lon ±360`, `throttle 0..1`, `commSignal 0..1`,
  `crewCurrent/Capacity ≤1024`). Free-form strings (`bodyName`,
  `situation`, `targetRunway`) get explicit `.max()` caps.
- **Files.** `backend/src/routes/api.ts` (`telemetrySchema`).

### M5. Dev-mode CORS reflection + credentials

- **Threat.** When `CORS_ORIGINS` was unset and `NODE_ENV !==
  "production"`, the backend reflected any `http(s)://localhost:*`
  origin AND set `credentials: true`. A hostile dev tool running on
  another loopback port could read authenticated tower data. In
  production the reflection was already off, but no guard prevented an
  operator from accidentally enabling it.
- **Fix.** `bootstrap()` now refuses to start in production if
  `allowAny` (`*` in `CORS_ORIGINS`) or `allowLocalDev` would be in
  effect — explicit allowlist required. Dev keeps the loopback
  fallback with a louder warning. `allowedHeaders` now lists
  `X-CSRF-Token` so the SPA can send it on preflighted requests.
- **Files.** `backend/src/index.ts`.

---

## LOW

### L1. `TRUST_PROXY` was hardcoded; wrong value silently breaks IP bans

- **Fix.** New env var `TRUST_PROXY` (defaults to
  `"loopback, linklocal, uniquelocal"`). Accepts `"true"`, `"false"`,
  numeric strings (`"1"`, `"2"`), or any value Express's `trust proxy`
  setting understands. Documented in `backend/src/config/env.ts` with
  the canonical mapping (1 = nginx, 2 = nginx behind ELB, etc.).
  `backend/src/index.ts` parses the string into the right type.
- **Why it matters.** Trust too much and clients spoof
  `X-Forwarded-For` to bypass IP bans / rate limits. Trust too little
  and every guest gets the proxy IP — one bad actor bans the whole
  front end.

### L2. `bearerMatchesDevSecret` scope

- **Status.** Already correctly limited to `NODE_ENV in {development,
  test}` (the env enum forbids `"staging"`, so the audit's concern
  about staging-mode dev secrets can't materialise). No code change
  beyond the existing guard; documented here so the next reviewer can
  skip it.

### L3. User-supplied text not stripped of control chars

- **Threat.** Length-capped strings still allowed ASCII C0/C1 control
  bytes (ANSI escape sequences in chat → coloured terminal logs;
  zero-width joiners → mod search bypass; U+0085 NEL → unexpected
  line breaks).
- **Fix.** New `backend/src/lib/safeText.ts` exports
  `stripControlChars()` and `safeStr(max)`. `safeStr` is a Zod string
  that strips control bytes (preserving `\t\n\r`) before length
  enforcement. Applied to: chat message body, report reason,
  ban/mute/banIp reasons, login displayName.

### L4. `pluginAuth` exchange-code issuance not throttled per user

- **Fix.** `pluginExchangeLimiter` (6/min/userId) wired into
  `POST /v1/auth/plugin/exchange-code`. Covered by H2's table above.

### L5. Voice bridge can rebind from loopback to LAN without auth

- **Threat.** PCM and CTL sockets have no authentication — anyone who
  can talk to them can flip MIC_ON/MIC_OFF and read the room
  downlink. They're designed for loopback-only use by the KSP plugin
  on the same machine.
- **Fix.** `KSCTowerNetwork-voice-bridge/src/bridge.ts` hard-refuses
  to start if `PCM_HOST` or `CTL_HOST` is anything other than
  `127.0.0.1`, `::1`, or `localhost`. Override with
  `ALLOW_NON_LOOPBACK_BIND=1` (loud warning emitted).

### L6. `kickIdentityFromAllRooms` fan-out unbounded

- **Threat.** Banning a user in 200 rooms triggered 200 parallel
  LiveKit Server-API calls, which the cloud rate-limits and which can
  starve the Node event loop on the box.
- **Fix.** Shared `runWithConcurrencyCap()` in
  `backend/src/services/livekit.ts` with
  `LIVEKIT_FANOUT_CONCURRENCY = 8`. Used by both
  `kickIdentityFromAllRooms` and `revokePublishForIdentity`.

### L7. `pino-http` could log secrets if a future serializer changed

- **Fix.** Added `redact.paths` covering
  `req.headers.authorization`, `req.headers.cookie`,
  `req.headers["x-csrf-token"]`,
  `req.headers["x-ksc-voice-identity"]`,
  `res.headers["set-cookie"]`, and body fields `password`,
  `passwordHash`, `token`, `code`. `censor: '[REDACTED]'`.

### L8. Web app served without security headers

- **Fix.** Already covered as part of M2b above
  (`web/index.html` meta CSP +
  `web/vite.config.ts` `securityHeadersPlugin`).

---

## Side fixes shipped along the way

- **Critical Clerk vuln** (GHSA-vqx2-fgx2-5wq9, "Middleware-based route
  protection bypass") was patched via `npm audit fix` while installing
  new deps. `@clerk/shared` bumped to ≥4.8.1.
- **Missing `@types/jsonwebtoken`** added to `backend/devDependencies`.
  Was preventing `npm run typecheck` from passing cleanly.

---

## New runtime configuration

| Env var                    | Default                              | Where           | Notes |
| -------------------------- | ------------------------------------ | --------------- | ----- |
| `TRUST_PROXY`              | `loopback, linklocal, uniquelocal`   | backend         | See L1. Use `"1"` for single nginx, etc. |
| `ALLOW_NON_LOOPBACK_BIND`  | unset                                | voice bridge    | See L5. Set to `1` to expose PCM/CTL on LAN (DON'T). |

`WEB_LOGIN_USERS_JSON` entries gain an optional `passwordHash` field
that supersedes `password`. Plaintext is still accepted with a
one-time warning per email; migrate with:

```bash
node -e "import('argon2').then(a=>a.hash('YOUR_PASSWORD',{type:a.argon2id}).then(console.log))"
```

---

## Compatibility matrix

| Component               | Wire-protocol changes? | Rebuild required? |
| ----------------------- | ---------------------- | ----------------- |
| KSP plugin (C# DLL)     | None (Bearer + JSON)   | No                |
| Voice bridge            | None                   | No (just restart) |
| Web SPA                 | Adds cookie + CSRF flow; bearer still accepted | Yes (`vite build` for prod) |
| Backend                 | Adds `/v1/auth/logout`, `/v1/auth/csrf`, 429 + `csrf_*` reasons, `guest_revoked` reason | Yes (`tsc` for prod, `tsx watch` picks up in dev) |

---

## Verification commands

```powershell
# Backend
cd backend
npm run typecheck   # must exit 0
npm audit           # must report 0 vulnerabilities

# Web
cd web
npm run build       # must exit 0; CSP meta visible in dist/index.html

# Voice bridge
cd KSCTowerNetwork-voice-bridge
npx tsc --noEmit    # must exit 0

# KSP plugin (unchanged, but verify rebuild still succeeds)
cd KSCTowerNetwork-dev
powershell -ExecutionPolicy Bypass -File .\build-plugin.ps1
```

---

## Smoke-test checklist for a deploy

1. `POST /v1/auth/login` with a known email → response sets two
   cookies; body contains `token` and `csrfToken`.
2. `POST /v1/session/<id>/messages` from a freshly-loaded SPA →
   succeeds (CSRF token auto-bootstrapped + sent).
3. Same POST replayed from a different origin via fetch with
   `credentials: 'include'` and NO `X-CSRF-Token` → `403 csrf_missing`.
4. Same POST with bearer-only (no cookie) → succeeds (CSRF skipped for
   bearer-auth, by design — that's the KSP plugin path).
5. 11 rapid `POST /v1/auth/login` from the same IP → 11th returns
   `429 rate_limited`.
6. Upload a world-maps SVG containing `<script>alert(1)</script>` →
   `400 unsafe_svg`.
7. Telemetry payload with `lat: Infinity` → `400` from Zod.
8. Stop the backend, `kill -9` a guest's row in the DB / restart
   in-memory, then re-issue an old guest token → `401 guest_revoked`.
9. Try to start the voice bridge with `PCM_HOST=0.0.0.0` (no
   `ALLOW_NON_LOOPBACK_BIND`) → exits with code 2 and a clear error.
10. Start backend with `NODE_ENV=production CORS_ORIGINS='*'` →
    refuses to start.
