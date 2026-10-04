# Fragility Audit & Fix Plan

System-wide audit of "works until you change rooms / reload code / hit a transient blip → broken until restart" footguns. Triggered by the `AudioMixer` auto-close bug (already fixed in `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` via a silent keepalive stream).

Pattern across the system: **long-lived singleton resources with one-shot health checks and no recovery path.** First failure latches a "skipped/closed/dead" flag; the only way out is process restart.

---

## Severity legend

- **P0** — silent dead-air or stuck UI on routine actions (room change, role change, transient backend blip). Fix first.
- **P1** — degraded mode that survives the underlying problem (e.g. Redis came back, app stays in-memory).
- **P2** — robustness / hygiene; rarely user-visible but accumulates risk.

---

## P0 — Fix immediately

### 1. `VoiceDesk` stays glued to the old LiveKit room when `sessionId` changes
**File:** `KSCTowerNetwork-dev/web/src/pages/VoiceDesk.tsx` (≈93–95, 163–172, 306–320, 567–578)
**Symptom:** User tunes to room B (in another tab, via `useActiveRoom`, or storage event). UI shows new room but audio + participant list stay on room A until manual Disconnect or full page reload. This is the same shape as the bridge mixer bug: one long-lived client, no teardown on identity change.
**Fix:**
- Add `useEffect([sessionId])` that, when `connected || connecting`, calls the existing `disconnect()` path, resets `autoConnectForSessionRef`, and lets the auto-connect effect re-run with the new id.
- Cancel any in-flight token fetch (`AbortController`) before re-issuing.

### 2. `BoothDesk` booth voice not tied to `sessionId` changes — **mitigated in tree**
**File:** `KSCTowerNetwork-dev/web/src/pages/BoothDesk.tsx` (`prevVoiceSessionRef` + `useEffect` on `sessionId` calls `disconnectVoice()` when the active session id changes while a booth voice session exists).
**Residual risk:** Same as ops VoiceDesk if new race paths appear; re-verify after large refactors to `joinBoothVoice` / `disconnectVoice`.

### 3. `MIC_ON` latches `kspTxSockets` on failure → bridge goes silent
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈554–562, with the half-duplex check at 263–265 — line numbers shift slightly after the keepalive patch)
**Symptom:** `MIC_ON` adds the CTL socket to `kspTxSockets` *before* `sendPttToRoom(true)`. If `joinRoomIfNeeded()` left `roomJoined === false` or `sendPttToRoom` throws, the socket stays in the set. `pumpMixer` skips PCM while `kspTxSockets.size > 0`, so all downlink audio is suppressed until MIC_OFF or reconnect. Trivially reproducible right after a room switch.
**Fix:** Add to `kspTxSockets` only after `sendPttToRoom(true)` succeeds; on throw, `kspTxSockets.delete(socket)` and write `ERR ...` back. Symmetrically delete on socket `close`/`error` regardless of MIC state.

### 4. Bridge `pumpMixer` exits silently on any mixer error
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈260–280)
**Symptom:** `for await (const frame of mixer)` is wrapped in try/catch that only logs. If the mixer iterator ever throws or returns done (despite the keepalive — defense in depth), the pump stops forever and KSP gets dead air.
**Fix:** Wrap in a `while (!shuttingDown)` outer loop. On exit/throw: `mixer.aclose().catch(()=>{})`, recreate the mixer + keepalive, re-wire `streamRefs` (close stale ones), continue. Log loudly with a counter so an operator can see thrash.

### 5. Bridge `fetchLiveKitToken` has no timeout → can deadlock `joinInProgress`
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈129–135 + `joinRoomIfNeeded` 286–341, `reconnectRoom` 444+)
**Symptom:** A hung HTTP response (backend stuck, network black hole) blocks `tryConnect` indefinitely. `joinInProgress` stays true; concurrent callers bail; bridge appears connected to KSP but never re-enters LiveKit. Operationally indistinguishable from a deadlock.
**Fix:** Use `AbortSignal.timeout(8_000)` (or similar) on every `fetch`; treat timeout as a normal retryable error. Verify the `finally { joinInProgress = false }` executes on the abort path (it should, but add a test).

### 6. Backend: `dbSkipped` is a one-way door for the entire process
**Files:** `KSCTowerNetwork-dev/backend/src/lib/db.ts` (62–69, 100–128); `KSCTowerNetwork-dev/backend/src/httpApp.ts` (184–190)
**Symptom:** First failed `pingDb()` at boot tears down the pool and sets `dbSkipped`. `getDbPool()` throws forever after. If MariaDB starts up afterwards, the API stays in pure in-memory mode until process restart. Compounds with `services/repository.ts` (≈463, 480–523, 636+) which keeps sessions in-memory only while DB is "skipped."
**Fix:** Either
- (a) Background reconnect: every N seconds, re-run `pingDb()`; on success, recreate the pool, clear `dbSkipped`, log "DB recovered." Repository code already branches on `useDbPersistence()` so it should pick up automatically.
- (b) If DB is required in production: exit on `pingDb` failure and let the supervisor restart. Document which mode each environment uses.
Pick (a) for dev parity, (b) for prod, gated by an env flag.

---

## P1 — Robustness

### 7. Backend: `redisSkipped` is the same one-way door
**File:** `KSCTowerNetwork-dev/backend/src/lib/redis.ts` (5–7, 33–63)
**Symptom:** Once `pingRedis()` fails, `redisSkipped = true` and `getRedis()` throws for life. Rate limiter (`middleware/rateLimit.ts` 71–106) and plugin auth (`services/pluginAuth.ts` 23–27, 79+) silently fall back to in-memory and never re-attach when Redis returns. In multi-instance deployments, counters drift permanently.
**Fix:** Same pattern as #6 — periodic `pingRedis` retry that flips `redisSkipped` back to `false` and reconnects the client. Rebuild `lazyLimiter` cached instance on transition.

### 8. Backend: rate limiter pins store on first request, not connectivity changes
**File:** `KSCTowerNetwork-dev/backend/src/middleware/rateLimit.ts` (17–43, 71–106)
**Symptom:** First request after boot decides Redis-vs-memory store and that decision is sticky for the whole process. Even if Redis recovers (per #7), the limiter never rebuilds.
**Fix:** Invalidate the cached `inner` limiter when Redis connectivity transitions. Or use a store wrapper that probes Redis per-request with a tight timeout.

### 9. `VoiceDesk` caps not refreshed on role change
**File:** `KSCTowerNetwork-dev/web/src/pages/VoiceDesk.tsx` (100+, 322–323; vs `useLiveKitSessionCaps` elsewhere)
**Symptom:** `canPublish` / `canSubscribe` / `roomName` are read from the join token at `handleConnect` and cached in `caps`. If the user's role changes mid-session (spectator → pilot, controller claim, etc.), UI stays "listen only" until full disconnect/reconnect.
**Fix:** Invalidate or refetch caps when the relevant inputs change (`activeRoom`, `myRole`, role-bearing `auth/me` query). On meaningful change, force a `disconnect()` + reconnect with a fresh token. Reuse `useLiveKitSessionCaps`.

### 10. Bridge: `leaveRoom` doesn't clear `streamRefs` / `mixer.removeStream`
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (`leaveRoom` ≈345–355, subscribe handler 200–257)
**Symptom:** Relies on `RoomEvent.TrackUnsubscribed` firing during disconnect. If unsubscribes are reordered or missing, stale entries survive into the next session. Can collide with new sids or feed dead iterators into the mixer.
**Fix:** In `leaveRoom` (and on `RoomEvent.Disconnected`), explicitly iterate `streamRefs`, call `mixer.removeStream(it)` and any reader cancel, then `streamRefs.clear()`. Defense in depth; cheap.

### 11. Bridge: failed first join has no auto-retry path
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈311–337)
**Symptom:** If `joinRoomIfNeeded` throws something other than "Participant already exists," `roomJoined` stays false. `RoomEvent.Disconnected` won't fire (we never connected), so `reconnectRoom` is never scheduled. Operator sees "bridge up, KSP connected, but no room" until something else nudges (a new TCP session, MIC_ON, SESSION:).
**Fix:** On non-"already exists" join failure with `hasKspConnections() && !shuttingDown`, schedule a backoff retry (reuse `reconnectRoom` with a slightly different entry, or extract a shared retry loop).

### 12. Bridge: disconnect vs in-flight connect race
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (Disconnected handler ≈478–491, connect call sites 302–304)
**Symptom:** `RoomEvent.Disconnected` flips `roomJoined = false` while a `room.connect(...)` may still be awaiting completion. The connect can resolve afterwards and the bridge ends up with flag/SDK state mismatch (next path may fire "Participant already exists").
**Fix:** Connect-epoch / generation token. Increment on every disconnect; ignore connect resolution if the epoch changed. Or serialize all connect/disconnect through a single mutex (`async-mutex` is already in deps somewhere or trivial to write).

### 13. Bridge: `switchSession` not serialized
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈367–382)
**Symptom:** Two SESSION lines arriving back-to-back run overlapping `leaveRoom`/`joinRoomIfNeeded`. Possible interleaving → wrong room, partial disconnect, "Participant already exists" race, or dropped tune.
**Fix:** Single-flight queue keyed on session id. If a new SESSION arrives while one is in flight, store as "next desired" and let the current finish before applying.

### 14. Older `KSCTowerNetwork-voice-bridge/src/bridge.ts` still has the original mixer bug + no reconnect
**File:** `KSCTowerNetwork-voice-bridge/src/bridge.ts` (217 — `mixer.addStream` with no keepalive; 244 — single connect with no `RoomEvent.Disconnected` recovery)
**Symptom:** Same room-change footgun the active bridge had, plus no network blip recovery.
**Fix:** Either delete this file if unused, or port the keepalive + reconnect logic from the active bridge. Confirm via grep that `voice-bridge/voice-bridge` is the only build path used by `build-bridge-runtime.ps1` and `build-plugin.ps1`; if so, delete the dead variant.

### 15. Backend: `unhandledRejection` only logs
**File:** `KSCTowerNetwork-dev/backend/src/index.ts` (26–28)
**Symptom:** `uncaughtException` exits but `unhandledRejection` only logs. A rejected promise can leave half-mutated in-memory state while the server keeps serving — exactly the "feels stuck until restart" symptom.
**Fix:** Mirror `uncaughtException` policy in production (`process.exit(1)`); keep verbose logging in dev. Gate by `NODE_ENV`.

---

## P2 — Hygiene

### 16. Bridge: `broadcastPcm` has no per-socket error handling or backpressure
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (`broadcastPcm` 163–167)
**Fix:** Wrap each `s.write(buf)` in try/catch; on throw, `s.destroy()` and `pcmSockets.delete(s)`. Optional `'drain'` handling for slow consumers.

### 17. Bridge: TCP servers have no persistent `'error'` handler
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈507–510, 594–597)
**Symptom:** `pcmServer.on('error', reject)` is wired only to the initial `listen()` promise. Late `'error'` events become unhandled.
**Fix:** Add a long-lived `server.on('error', ...)` after `listen` resolves.

### 18. Web: `connectVoiceRoom` `disconnect` doesn't `removeAllListeners` — **fixed in tree**
**File:** `KSCTowerNetwork-dev/web/src/voice/livekit.ts` (`disconnect()` calls `room.removeAllListeners()` before `room.disconnect()`).
**Residual risk:** None unless a fork drops that line again.

### 19. Bridge: `void (async () => {...})()` per CTL command — no per-socket ordering
**File:** `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` (≈537–582)
**Symptom:** Two commands on one socket can apply out of order (e.g. `SESSION:foo` followed immediately by `MIC_ON` could MIC_ON the old room).
**Fix:** Per-socket serial queue.

### 20. Web: `useAuthMe` 30s `staleTime` can show stale role
**File:** `KSCTowerNetwork-dev/web/src/auth/useAuthMe.ts` (44–50)
**Symptom:** After role promotion in another tab, current tab can show old role for up to 30 s if it's not focused.
**Fix:** Reduce `staleTime` for auth or add explicit `queryClient.invalidateQueries(queryKeys.auth.me)` calls at known role-change boundaries (admin grant, claim tower, etc.).

### 21. Web: Checklist SSE + 6s fallback poller can run concurrently after recovery
**File:** `KSCTowerNetwork-dev/web/src/session/ChecklistModal.tsx` (218–272)
**Fix:** Stop the fallback poller on `EventSource.onopen` rather than only on unmount.

### 22. Backend: checklist events Map is single-process only
**File:** `KSCTowerNetwork-dev/backend/src/services/checklistEvents.ts` (25–39)
**Status:** Documented at file top. Only an issue when scaling out backend. Skip unless deploying multi-instance.
**Fix (when needed):** Redis pub/sub (or any pub/sub) for cross-instance fan-out.

---

## Cross-cutting recommendation: codify the recovery pattern

Most of these P0/P1 items are the same shape:

> Long-lived singleton + one-shot health check + no recovery loop.

Add a small reusable helper, e.g. `createHealthGated<T>({ probe, build, teardown, intervalMs })` that:
1. Builds the resource on first successful `probe()`.
2. On error, runs `teardown()`, marks unhealthy.
3. Periodically retries `probe()` while unhealthy and rebuilds on success.
4. Exposes `get()` (throws when unhealthy) and `tryGet()` (returns null).

Apply to: DB pool (#6), Redis (#7), rate limiter (#8), bridge mixer (defense-in-depth on top of keepalive, #4).

---

## Suggested rollout order

1. **Bridge hot-fixes (one PR):** #3, #4, #5, #10, #11, #12, #13, #16, #17. Same file, same review context, all "the bridge survives a session change cleanly."
2. **Web room-change fixes (one PR):** #1, #2, #9, #18. Same theme, easy to verify by hand.
3. **Backend recovery (one PR):** #6 + #7 + #8 + #15, plus the `createHealthGated` helper.
4. **Cleanup:** #14 (delete or sync the old bridge variant), #19, #20, #21.
5. **Defer until needed:** #22.

## Manual repro tests after each PR

- Bridge: with KSP connected, send `SESSION:room-a`, then `SESSION:room-b` repeatedly; toggle MIC_ON/MIC_OFF across the boundary; kill backend mid-token-fetch; verify no restart needed.
- Web: open `/voice` in two tabs as the same user; switch active room in tab 1; tab 2 should detach from old room and attach to new room without reload.
- Backend: boot with MariaDB/Redis off, start them after 30 s; verify routes that need them start working without backend restart.
