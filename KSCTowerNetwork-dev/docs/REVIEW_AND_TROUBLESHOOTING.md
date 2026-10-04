# KSCTowerNetwork — Security review + troubleshooting

This document combines a structured security/footgun review with practical debugging for the most common “nothing works” symptoms (stuck on `dev-shared`, tuning from KSP doesn’t join a web-created room).

---

## Part A — Security, footguns, and logic (review)

### Already documented

The repo’s [`AUDIT.md`](AUDIT.md) remains the authoritative checklist. Several **Critical/High** items are **partially or fully fixed in current code**, including:

- `DEV_OPEN_AUTH` defaulting to off (no silent open relay).
- CORS: explicit allowlist instead of reflecting arbitrary `Origin`.
- Web login: empty `WEB_LOGIN_USERS_JSON` rejects logins unless dev-only `DEV_DEFAULT_WEB_USER` is explicitly enabled.
- Lobby roster: non-mods no longer receive other pilots’ raw user ids (identity fields scrubbed).
- Plugin exchange codes: Redis `SET … NX` reply is checked; collisions retry.
- Bans: composite `(user_id, kind)` so mute doesn’t clobber ban.
- Tower queue: `claimNextTowerForSession` uses `ZREM` so two callers can’t claim the same controller.

Skim **AUDIT.md** before changing auth, persistence, or the voice bridge.

### Security & operations

1. **Voice bridge → backend has no `Authorization` header**  
   The Node bridge only sends `Content-Type` and the dev identity header when fetching LiveKit tokens. The backend only honors `x-ksc-voice-identity` when dev open-auth is on; production forbids that env. **Strict production** deployments need a clear story: service JWT, proxy-injected bearer, or documented limitation. Verify your real setup matches what you assume.

2. **JWT verification without explicit `algorithms`**  
   `jwt.verify` in `backend/src/middleware/auth.ts` should ideally pass `algorithms: ['HS256']` to pin algorithm choice (defense in depth).

3. **`KSC-TOWER-*` hullcam namespace + predictable ids**  
   Tower stream ids are derived from a hash of normalized email. Anyone who knows the pilot’s email can compute the same `KSC-TOWER-*` id. Any authenticated user can publish frames to that namespace (no pilot-only check). That’s a targeted harassment / stream-spoof vector if email is known.

4. **Trust proxy**  
   `TRUST_PROXY` must match your edge. Wrong settings → spoofed `X-Forwarded-For` (weak bans/rate limits) or everyone sharing one IP (over-broad blocking).

5. **Registered users file path**  
   `REGISTERED_USERS_PATH` is resolved from `process.cwd()`. If the service cwd isn’t what you expect (systemd, Docker), the file can be wrong or “empty after restart.”

6. **Plugin transport**  
   Tokens live in `auth.cfg` and are sent as Bearer. HTTP on an untrusted network is MITM-risk; prefer HTTPS for `ApiBaseUrl` in real deployments.

### Logic & consistency

7. **`anon-{MachineName}` tower-stream id**  
   With no email, the `KSC-TOWER-*` id uses the machine name; two accounts on one PC could theoretically collide in that namespace (edge case).

8. **Fragile JSON parsing in the plugin**  
   `TowerLoginGui` still extracts `"token"` / `"code"` with regex. Fine until the API shape changes.

9. **`ResolveUnderKspRoot` allows absolute paths**  
   Rooted `BridgeExecutable` / working directory bypass the KSP root — misconfiguration can run the wrong binary (local footgun).

### Voice bridge (still relevant)

10. **Control socket**: data buffers until `\n` — no max line length → memory pressure if something sends garbage without newlines (local).

11. **Concurrent `MIC_ON`/`MIC_OFF`**: async handlers can complete out of order under load (PTT edge cases).

### Questions to resolve in your deployment

- **Production voice bridge**: How does `POST /v1/session/:id/livekit-token` authenticate when `NODE_ENV=production` and Clerk/app JWT is required?
- **`KSC-TOWER` publish policy**: Is “any logged-in user can publish to a guessed id” acceptable, or should publish be bound to the owning account?
- **Multi-instance backend**: More than one Node process behind a load balancer can split in-memory state vs Redis; behavior can be subtle.

---

## Part B — Why the game stays on `dev-shared`

### What `dev-shared` is

In `TowerModSettings.EnsureLoaded()`, the default is:

```csharp
SessionId = "dev-shared";
```

That value is the **bootstrap channel** until something successfully switches the active channel (usually `SetActiveChannel` with a real server **session UUID**).

### What is supposed to replace it

1. **`TowerSessionAutoCall`** (Flight / KSC, runs once per game):  
   - Waits for `TowerAuthToken` (unless `SkipTowerLogin`).  
   - Runs **plugin token self-heal** (`tower_web` → `plugin_session` via exchange) so `POST /v1/session/call` is allowed for pilots.  
   - Calls `GET /v1/me/active-room` — if you’re already the **pilot** of a room, it adopts that id.  
   - Otherwise `POST /v1/session/call` to create a pilot session and then calls `SetActiveChannel(newSessionId)`.

If any step fails, **`SessionId` can remain `dev-shared`**.

### Common failure modes (check `KSP.log`)

| Symptom | Likely cause |
|--------|----------------|
| Stuck on `dev-shared`, log says “no auth token within 300s” | Not logged in in-game; `SkipTowerLogin` is false and `auth.cfg` has no token. |
| “exchange-code failed” / “403” on session/call | Persisted JWT is still `tower_web` and exchange failed; pilot exemption only applies to `plugin_session`. |
| “Auto-call POST failed (HTTP 403)” | Same: not a plugin token, or backend refuses role (e.g. web user without permission to create session). |
| Backend not reachable | Wrong `towerApiHost` / `towerApiPort` / path in `settings.cfg`, or firewall. |

**Action:** Log in via the in-game tower login, confirm `GameData/KSCTowerNetwork/PluginData/auth.cfg` contains a token after login, restart and watch for `[KSCTowerNetwork] Auto-call` lines. If exchange fails, fix backend URL and that user must have `plugin:use` / successful exchange.

---

## Part C — Why dialing in KSP doesn’t join a room created on the web

### How “tune to frequency” is supposed to work

The in-game radio does **not** magically know web UUIDs. Flow:

1. **`GET /v1/lobby/rooms`** (with the same Bearer as login) fills `_sessionIdToRoom` with each room’s `roomId` and `frequencyMhz`.
2. When you commit a frequency on the dial, **`TryFindRoomIdForFrequency`** looks for a lobby room whose **`frequencyMhz` string exactly matches** the six-digit dial string (e.g. `118.300`).
3. If found → **`AdoptRoomId`** → `SetActiveChannel(realUuid)`.
4. If **not** found → **`POST /v1/session/call`** with that frequency as the **name** → **creates a new room** (not joining the web one).

So “nothing happens” or “it creates another room” usually means **step 1 or 2 failed**.

### Checklist

1. **Same API as the web**  
   Plugin `ApiBaseUrl` (from `settings.cfg`: host + port + `/v1`) must hit the **same backend** where the web created the room. If the web uses `http://127.0.0.1:45173` (Vite) and the plugin points at the wrong port, the lobby list is empty or wrong.

2. **Logged in**  
   If `SkipTowerLogin` is false and there is no token, **`/lobby/rooms` returns 401** and the radio won’t populate the frequency map (see `TowerRadioGui` — it skips fetch without a token).

3. **Exact frequency match**  
   Matching is **string equality** on `frequencyMhz` vs the dial’s `NNN.NNN` format. If the server stores `118.30` vs `118.300`, or different rounding, **no match** → new room on tune. Compare the room’s frequency in the web UI to what the dial commits.

4. **`FREQUENCY_CHANNEL_MAP` in `settings.cfg`**  
   Example placeholders like `121.50 = ksc-tower` are **not** live server session ids. Real ids are UUID-like strings from the API. For IVA radio hardware sync, map a MHz value to the **actual `sessionId`** you care about, or rely on the lobby fetch + dial (no manual map needed if lobby works).

5. **Auto-call vs manual tune**  
   Auto-call creates **your** pilot session (planet-pack name). A **controller-created** web room is a different session unless you **tune to that room’s frequency** after lobby refresh or **paste/adopt** the correct id via supported UI flows. Creating a room from the web and a room from KSP are two sessions unless you join by frequency/UUID.

### Quick debug sequence

1. Confirm backend: open browser to same base as plugin `ApiBaseUrl`, verify health/login.  
2. In KSP, open tower login, log in, confirm `auth.cfg` updated.  
3. Watch `KSP.log` for `Auto-call: created pilot session <uuid>` or errors.  
4. Open the in-game radio panel long enough for lobby refresh; then tune to the **exact** MHz shown on the web card for the target room.  
5. If it still creates a new room, log `GET /v1/lobby/rooms` response (browser or curl with Bearer) and compare `frequencyMhz` strings to the dial.

---

## Part D — Related files (for maintainers)

| Area | Location |
|------|----------|
| Default `dev-shared`, `SetActiveChannel`, frequency map | `PluginSrc/TowerModSettings.cs` |
| Auto room + plugin token exchange | `PluginSrc/TowerSessionAutoCall.cs` |
| Lobby fetch + tune-by-frequency | `PluginSrc/TowerRadioGui.cs` |
| IVA dial → channel | `PluginSrc/TowerCommRadioFreqSync.cs` |
| Session/call + lobby API | `backend/src/routes/api.ts` |

---

*Generated for local debugging; tighten production policies separately from this doc.*
