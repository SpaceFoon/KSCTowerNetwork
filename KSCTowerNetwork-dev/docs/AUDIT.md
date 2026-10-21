# KSCTowerNetwork Foot Gun Audit

Repo-wide audit covering: backend (`KSCTowerNetwork-dev/backend/src/`), frontend (`KSCTowerNetwork-dev/web/src/`), KSP plugin (`KSCTowerNetwork-dev/PluginSrc/`), and voice bridge (`KSCTowerNetwork-voice-bridge/voice-bridge/`).

Severity: **Critical** must be fixed; **High** can compromise reliability/UX; **Medium** is real but bounded; **Low** is hygiene.

> **Status legend.** Items marked **[FIXED]** have been verified against current
> source. Items marked **[OPEN]** still apply (or have not been re-verified).
> Re-confirm line numbers before relying on a specific fix — this file drifts
> faster than the code does. Previous full status sweep: 2026-04-22; the scoped
> public-readiness findings below were checked on 2026-10-21.

## 2026-10-21 scoped public-readiness audit — fixed

The security scan of the current worktree reported seven findings. These
fixes were applied and rechecked in source:

- **Ban enforcement:** role/capability middleware rejects banned accounts;
  WebSocket delivery rechecks access and closes banned clients; local UDP
  checks the development identity.
- **Cookie CSRF:** mutation requests carrying the session cookie require the
  CSRF token even before authentication middleware has populated `req.auth`.
- **Session access:** `GET /session/:sessionId` checks membership for every
  token type.
- **Pilot claim:** `/session/claim-pilot` requires a `plugin_session` token.
- **UDP token exposure:** authenticated app tokens are never sent over UDP.
  The listener is disabled by default, binds to loopback, and accepts only
  empty-token local-development packets.
- **UDP resource limits:** telemetry is limited to 15 packets per second per
  user and the side-effect queue is capped at 256 jobs.
- **Voice bridge bind:** PCM/CTL sockets refuse non-loopback hosts unless
  `ALLOW_NON_LOOPBACK_BIND=1` is explicitly set.

### Dependency audit follow-up

Updating packages within their declared ranges exposed an advisory in
Stryker's `typed-rest-client`, which pinned `qs@6.15.1`. A scoped npm override
now requires `qs ^6.16.0`; all three package audits report zero vulnerabilities.

Other entries in this file remain separate known issues and were not part of
this scoped scan.

Verification on 2026-10-21 with Node 24.22.1: backend build/typecheck/tests
passed (238 passed, 4 skipped); web build/tests passed (121 tests); voice-bridge
build/tests passed (16 tests); KSP plugin build succeeded; `npm audit` reported
zero vulnerabilities in each package. The plugin build emitted 14 CS0649
warnings in `TowerAcarsGui` deserialization fields.

---

## Critical

### C1. Default web credentials shipped in code — **[FIXED]**
- File: `backend/src/services/webAuth.ts` (constants `DEFAULT_WEB_LOGIN_*`, `defaultUserAllowed()`).
- Original failure mode: hard-coded fallback `tower@ksc.local` / `tower12345` / user id `tower_local` was active whenever `WEB_LOGIN_USERS_JSON` was unset, so anyone reaching `/v1/auth/login` could become that principal.
- Current behavior: the built-in dev login is gated behind `DEV_DEFAULT_WEB_USER=1` **and** `NODE_ENV !== "production"`. With `WEB_LOGIN_USERS_JSON` unset and the flag off, `/v1/auth/login` rejects all attempts and the boot warning instructs operators to set one or the other (`webAuth.ts` `defaultUserAllowed`, `loadConfiguredUsers`).
- Residual risk: dev images that ship with `DEV_DEFAULT_WEB_USER=1` will still expose the well-known credentials. Treat the flag as production-grade — never enable it on a host reachable from the public internet.

### C2. `DEV_OPEN_AUTH` defaults to `true` — **[FIXED]**
- Files: `backend/src/config/env.ts` (`DEV_OPEN_AUTH` schema), `backend/src/services/repository.ts`, `backend/src/index.ts`.
- Original failure mode: a process started without `NODE_ENV=production` ran with auth bypass + implicit in-memory persistence.
- Current behavior: `DEV_OPEN_AUTH` defaults to `false` and the production guard in `env.ts` continues to refuse `true` when `NODE_ENV=production`. In-memory persistence is now its own opt-in (`DEV_IN_MEMORY=1`) instead of being implied by `DEV_OPEN_AUTH`.
- Residual risk: local `.env.development` files that explicitly set `DEV_OPEN_AUTH=1` still bypass auth. Never commit `.env.development` / `.env.production` (gitignored).

---

## High

### Backend

- **H-B1. Tower-queue race.** `nextTowerExcluding` then `assignTower` is a read-then-write with no row lock. `backend/src/services/repository.ts:548-566`, `:645-672`, `backend/src/routes/api.ts:367-372`. Two sessions can be assigned the same controller. Fix: atomic Lua script in Redis, or `SELECT ... FOR UPDATE` in DB path.
- **H-B2. Plugin exchange-code can vanish.** `services/pluginAuth.ts:19-27` doesn't check `SET ... NX` returning `null`; on collision the catch path doesn't run. Fix: handle `null` reply explicitly; retry with a fresh code.
- **H-B3. `bans` table key collision.** Schema `PRIMARY KEY (user_id)` for both ban and mute upserts. `services/repository.ts:128-134`, `:401-434`, `:859-906`. Mute upsert overwrites ban row. Fix: composite PK `(user_id, kind)` and explicit kind column.
- **H-B4. Inconsistent ban check on Redis-down path.** `services/repository.ts:559-565` uses `localBans.has(userId)` instead of `isUserBanned`. Mutes block tower assignment when Redis is down. Fix: call `isUserBanned`/`localBanIsActive` consistently.
- **H-B5. Lobby roster leak.** `routes/api.ts:477-501` `GET /lobby/rooms` is `requireAuth` only - guests enumerate sessions and assigned controllers. Fix: gate behind `requireMod` or scrub user-identifying fields for non-mods.
- **H-B6. Reflective CORS with credentials. — [FIXED]** `backend/src/index.ts` no longer uses `cors({ origin: true, credentials: true })`. Origins now come from an explicit `CORS_ORIGINS` allowlist; in dev a loopback regex (`localhost`/`127.0.0.1`/`[::1]` on any port) is allowed. The startup code refuses to boot in production if the resolved config would allow `*` or the loopback fallback (`resolveCorsOrigins` + the `NODE_ENV === "production"` guard in `index.ts`). `credentials` is auto-disabled when `*` is allowed.

### Frontend

- **H-F1. RoomPage doesn't tear down on remote disconnect.** `web/src/pages/RoomPage.tsx:286-294` `onConnectionState=Disconnected` only clears `handleRef`/`setConnecting(false)`. Mic meter, `getUserMedia` track, and `subscribeIncomingLevel` RAF leak. Fix: call the same cleanup that `disconnectVoice` runs.
- **H-F2. VoiceDesk unmount (resolved in current tree).** Unmount cleanup runs the same `disconnect()` used by the Leave button, which tears down LiveKit, Kerbalizer/`releaseKerbalizerMic`, and incoming-level subscription. Re-open if a new embed path mounts VoiceDesk without that effect.
- **H-F3. LiveKit caps race.** `web/src/session/useLiveKitSessionCaps.ts:39-69` has no abort or sequence id. Fix: AbortController keyed by `sessionId`, or a request-id guard.

### Plugin (C#)

- **H-P1. Synchronous TCP on the main thread.** `PluginSrc/TowerRadioGui.cs:607-667`, `:183-195`, `PluginSrc/KSCTowerRpmMic.cs:14-44` call `TrySendLine` from the GUI / `OnApplicationQuit`. `PluginSrc/TowerVoiceBridgeControl.cs:27-60` has no connect timeout. Fix: short connect timeout + push send to background thread / queue.
- **H-P2. Unity API on a worker thread.** `PluginSrc/TowerVoicePlayback.cs:339-347` calls `Debug.LogWarning` from the TCP read thread. Fix: queue log lines to the main thread.
- **H-P3. JWT in plaintext under `GameData`.** `PluginSrc/TowerModSettings.cs:358-385` writes `towerAuthToken` and email to `auth.cfg`. Fix (minimal): DPAPI on Windows; otherwise warn and require opt-in.

### Voice bridge

- **H-V1. No LiveKit reconnect or token refresh.** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts:156-201` does one `connect`, no `RoomEvent.Disconnected` handler. Fix: install handler, refetch token, exponential-backoff reconnect.

---

## Medium

### Backend

- **M-B1.** `jwt.verify` without `algorithms: ['HS256']`. `backend/src/middleware/auth.ts:87-118`.
- **M-B2.** `e.message` echoed to client in `/ban`/`/mute`/`/role` catches. `backend/src/routes/api.ts:736-813`.
- **M-B3.** Process-local `Map`/`Set` everywhere - split brain on multi-process. `backend/src/services/repository.ts` (multiple).
- **M-B4.** `MARIADB_PASSWORD=""`, `MARIADB_USER=root` defaults. `backend/src/config/env.ts:53-56`.
- **M-B5.** `redisSkipped` never recovers. `backend/src/lib/redis.ts:9-31`.
- **M-B6.** Guest creation logs IP + display name (PII). `backend/src/services/guestAuth.ts` via `logAction`.

### Frontend

- **M-F1.** `apiFetch` has no `AbortSignal`. `web/src/api/client.ts:24-77`.
- **M-F2.** `x-ksc-voice-identity` header not dev-gated. `web/src/api/client.ts:36-38`, `web/src/api/devVoice.ts`.
- **M-F3.** `dangerouslySetInnerHTML` for terrain SVG. `web/src/pages/TowerDesk.tsx:1522-1527` (only `preserveAspectRatio` patched).
- **M-F4.** Impure `useMemo` mutates `lastHeadingRef.current`. `web/src/pages/TowerDesk.tsx:1274-1302`.
- **M-F5.** `?session=` in URL. `web/src/pages/VoiceDesk.tsx:102-106`.
- **M-F6.** Aggressive 1 s telemetry polling. `web/src/pages/TowerDesk.tsx:948-953`.
- **M-F7.** Bearer + user JSON in `localStorage` (standard SPA risk).

### Plugin

- **M-P1.** `Thread.Join(1200)` on main thread. `PluginSrc/TowerVoicePlayback.cs:205-232`.
- **M-P2.** `taskkill /F /T` + `WaitForExit(8000)` blocks quit up to 8 s. `PluginSrc/TowerModSettings.cs:753-776`.
- **M-P3.** Duplicate `TowerLoginGui` uses `Destroy(this)` not `Destroy(gameObject)`. `PluginSrc/TowerLoginGui.cs:20-29`.
- **M-P4.** `ResolveUnderKspRoot` allows absolute paths outside the KSP tree. `PluginSrc/TowerModSettings.cs:108-109`.
- **M-P5.** `EnsureLoaded()` reads settings once and never re-reads. `PluginSrc/TowerModSettings.cs:77-85`.
- **M-P6.** Empty / silent catches drop diagnostic info. `PluginSrc/TowerVoiceBridgeControl.cs:61-65`, `PluginSrc/TowerModSettings.cs:576-636`.
- **M-P7.** `ReadHeaderLine` flips `_headerDone = true` even on malformed header. `PluginSrc/TowerVoicePlayback.cs:405-448`.
- **M-P8.** `Microphone.End(_device)` mismatched with `_device=null` start. `PluginSrc/TowerMicMeter.cs:104-128`.

### Voice bridge

- **M-V1.** Watchdog disabled by default + `tasklist` failure fail-open. `voice-bridge/src/bridge.ts:52-71`. Non-Windows always returns true.
- **M-V2.** Unbounded control-socket buffer (no `\n` -> OOM). `voice-bridge/src/bridge.ts:217-254`.
- **M-V3.** Concurrent `MIC_ON`/`MIC_OFF` IIFEs can complete out of order. Same range.
- **M-V4.** LiveKit token API errors stringified into `Error` messages (secret echo risk). `voice-bridge/src/bridge.ts:100-107`.
- **M-V5.** No `process.on('unhandledRejection'/'uncaughtException')`. `voice-bridge/src/bridge.ts:335-339`.
- **M-V6.** `start-bridge.cmd` sets `KSP_WATCHDOG=1` while raw `node dist/bridge.js` doesn't - dev/prod divergence. `voice-bridge/scripts/build-bridge-runtime.ps1:74-85`.
- **M-V7.** `npm start` doesn't pre-build. `voice-bridge/package.json:11`.

---

## Low

- **L-B1.** No graceful shutdown - no `server.close()`/`pool.end()`/Redis `quit()`. `backend/src/index.ts:53-68`.
- **L-B2.** `livekit.ts updateParticipant` sets `canPublishData: true` on mute. `backend/src/services/livekit.ts:150-154`.
- **L-B3.** `services/store.ts` is unused dead code.
- **L-F1.** `formatApiError` has no `"handoff"` branch but `ChatDesk.tsx:114` passes it.
- **L-F2.** Admin/chat mutations have no optimistic-concurrency token.
- **L-P1.** Login UI claims tokens are saved in `settings.cfg` but they go to `auth.cfg`. `PluginSrc/TowerLoginGui.cs:105-106`.
- **L-P2.** Regex JSON extraction is fragile. `PluginSrc/TowerLoginGui.cs:233-257`. `JsonEscape` doesn't handle all control chars.
- **L-P3.** Ad-hoc JSON parsing for `nextTelemetrySeconds`. `PluginSrc/TowerTelemetryPublisher.cs:87-130`.

---

## Notable positives

- Backend: timing-safe bearer/password compare; SQL parameterized; `express.json({ limit: "1mb" })`; production guard refusing default JWT secret; `pluginAuth` MULTI get+del when Redis works; Express 5 (async-route safe).
- Plugin: `TowerToolbar` properly unsubscribes `GameEvents`; `TowerVoiceBridgeRespawnQueue` correctly marshals to main thread; `volatile`/`Interlocked` used in cross-thread paths.
- Voice bridge: clean shutdown via SIGINT/SIGTERM; subscription bookkeeping prevents duplicate mixer inputs; binds default to loopback.
