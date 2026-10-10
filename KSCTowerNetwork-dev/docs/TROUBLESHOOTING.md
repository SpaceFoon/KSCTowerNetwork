# Troubleshooting

Symptom-first lookup. Each entry: what you see → what's likely wrong → how
to fix.

## Backend won't start

### `Error: APP_JWT_SECRET must be overridden in production`

`NODE_ENV=production` and `APP_JWT_SECRET` is still the dev default
(`dev-only-change-me-please`). Set a long random secret.

### `Error: DEV_* auth flags must not be set in production`

One of `DEV_OPEN_AUTH`, `DEV_BEARER_SECRET`, `DEV_VOICE_IDENTITY_HEADER`,
`DEV_DEFAULT_WEB_USER`, `DEV_IN_MEMORY` is set with `NODE_ENV=production`.
Unset it. Don't bypass the guard — those flags exist because each one was
a real prod foot-gun.

### `ZodError` at startup

Something in the env doesn't match the schema in `backend/src/config/env.ts`.
The error names the field. Common: `MARIADB_PORT` is non-numeric, or a
URL is empty string instead of unset.

### `connect ECONNREFUSED 127.0.0.1:3306`

MariaDB unreachable. Either start MariaDB, set `MARIADB_HOST` correctly,
or set `DEV_IN_MEMORY=true` (dev only) to use the in-memory store.

## Web SPA

### "No auth configured" error from API

Backend doesn't have `DEV_OPEN_AUTH`, no `DEV_BEARER_SECRET`, and no
Clerk keys, and no `WEB_LOGIN_USERS_JSON`. In dev, set
`DEV_OPEN_AUTH=true` and `DEV_DEFAULT_WEB_USER=true`. In prod, set
`WEB_LOGIN_USERS_JSON` (and Clerk keys if using Clerk).

### CORS error in browser console

Backend's `CORS_ORIGINS` doesn't include your web origin. Set
`CORS_ORIGINS=https://your-host` (exact match including protocol). `*`
works but disables credentialed requests. Restart backend.

### Login succeeds, then every request 401s

`localStorage.getItem('ksc.session.v1')` is set but the token's signature
doesn't validate. Likely the backend was restarted with a new
`APP_JWT_SECRET`. Clear localStorage and re-login.

### Map doesn't render in TowerDesk

`worldMaps` layer hasn't been baked yet. The KSP plugin's
`TowerBasemapBaker` must run at least once with a vessel on Kerbin to
publish `/v1/world-maps/:sessionId/...`. Until then, the map shows the
fallback grid.

### Mic active but other participants hear silence

Open the browser console with the LiveKit room connected and check that
`LocalParticipant.audioTracks` is non-empty and unmuted. Then verify the
Kerbalizer worklet didn't throw — the worklet logs to console on init.
On Safari/iOS the AudioWorklet is sometimes blocked; the fallback chain
should engage automatically.

## Lobby and tower sessions

### Tower room disappeared from the lobby while I was still "in" KSP

The backend may have **auto-closed** the session after **`PILOT_IDLE_CLOSE_SECONDS`**
(default **120**) without a fresh **`POST /v1/telemetry/:sessionId`** (last
`lastTelemetryAt` too old). Typical causes: quit to space center without a
successful `scene_left` path, game crash, beacon off with no further samples, or
long AFK with no flight scene sending telemetry. **Fix:** start telemetry again
and open a new room, or raise / disable the idle window — see
[SETTINGS_REFERENCE.md → Telemetry](SETTINGS_REFERENCE.md#telemetry)
(`PILOT_IDLE_CLOSE_SECONDS`, `PILOT_IDLE_SWEEP_INTERVAL_SECONDS`).

### My room stayed in the lobby after I closed KSP

**Expected for up to ~2 minutes** (default idle close) if the last telemetry
timestamp is still "fresh" from the server's point of view, or longer if you
never flew (no `lastTelemetryAt` — idle auto-close does not run). To remove the
room immediately, use **Close** on the lobby card (`DELETE /v1/session/:id`).
Closing the **browser** tab while seated as **controller** releases the tower
seat via `release-tower`; **pilots** are not auto-closed on tab unload.

## KSP plugin

### Plugin not loaded

Open `<KSP>/KSP.log`. Search for `KSCTowerNetwork`. Common:

- `Could not load assembly`: DLL built against wrong KSP version. Rebuild
  with `build-plugin.ps1` against your install's Managed/ folder.
- `Cannot find type ...` from KSPAddon: the DLL is fine but a dependent
  mod is missing (e.g. RasterPropMonitor for the IVA prop).

### KSP freezes for 1-3 seconds when toggling PTT

A blocking TCP send is happening on the main thread. Make sure the call
goes through `TowerVoiceBridgeControl.EnqueueSend` (background thread),
not raw `socket.Write`. See `AUDIT.md` "High Severity" entry.

### `auth.cfg` exists but plugin asks for login again

`/v1/auth/me` returned 401. Likely backend rotated `APP_JWT_SECRET` or
the session was banned. Pair again via the login GUI.

### Voice bridge doesn't auto-start

Check `settings.cfg`:

- `autoStartVoiceBridge = True`
- `bridgeExecutable` points to an existing `start-bridge.cmd`

Check the KSP log for the spawn line. If you see `Win32Exception: file
not found`, the path in `bridgeExecutable` is wrong.

### "Bridge runtime missing" warning

The bundled `bridge-runtime/` folder isn't where the plugin expects it.
Re-run `build-bridge-runtime.ps1` or extract a fresh release ZIP.

## Voice bridge

### `livekit-token HTTP 401`

Backend rejected the token request. Causes:

- `LIVEKIT_BRIDGE_IDENTITIES` doesn't include `ksp_bridge`.
- `DEV_VOICE_IDENTITY_HEADER` not set in dev (so the bridge can't
  introduce itself as `ksp_bridge`).
- LiveKit creds (`LIVEKIT_API_KEY`/`SECRET`) missing.

### `livekit-token HTTP 404`

Wrong `TOWER_API_BASE`. The bridge's `start-bridge.cmd` should set this
from the plugin's settings. Verify in the bridge's stdout banner.

### Bridge connects, plays audio, then goes silent after ~10 minutes

LiveKit token TTL expired and the bridge missed `RoomEvent.Disconnected`.
Old build. Rebuild from current `bridge.ts` — the disconnect handler with
exponential backoff was added specifically for this.

### KSP closes but `node.exe` lingers

Watchdog disabled (`KSP_WATCHDOG` unset) or `tasklist` failed. Check the
bridge log for "watchdog check failed". Set `KSP_WATCHDOG=1` in
`start-bridge.cmd`. On non-Windows the watchdog is a no-op by design.

### Bridge crashes on first `MIC_ON`

You're running an old build that captured audio in-process. Current
bridge uses `publishData` + tower-side mic; never opens a mic. Rebuild.

## LiveKit

### `Failed to connect to room: invalid token`

Token's `room` claim doesn't match the room name the client is joining.
Backend mints `tower-{sessionId}` — make sure the client passes the same
sessionId. The wsUrl in the token-mint response is also the right one to
use; don't substitute a different one.

### Browser hears echo

Both tower and bridge are subscribed to the tower's own publish (loop).
Tower-side LiveKit `RoomOptions` should have `dynacast: true` and the
bridge should not have any echo-cancel side-effect. If it persists, the
KSP `AudioSource` may be picking up speaker output via the system mic
when the user has speakers (not headphones). Use headphones or enable
echo cancellation on the OS side.

### Web **Incoming** meter stuck at 0 while you still hear remote audio

Hard-refresh the tower web app after upgrades. Older builds used only
frequency-domain analyser reads (often flat for Opus speech) and did not
reliably `resume()` the Web Audio context created per remote track; current
`web/src/voice/livekit.ts` blends time-domain RMS and awaits `AudioContext`
`resume()` after subscribe.

On **Booth (spectators)**, the meter appears only after **Join booth voice**
— `BoothDesk` uses the same `subscribeIncomingLevel` path as ops `VoiceDesk`.

## Database / persistence

### Sessions disappear on restart

`DEV_IN_MEMORY=true` and `NODE_ENV=development`. By design. Set
`DEV_IN_MEMORY=false` and provide a real DB.

### Bans don't take effect

`bans` table key collision: the same `userId` row gets overwritten by a
mute-or-ban upsert if both kinds are written. See `AUDIT.md` "High
Severity". Schema fix: composite PK `(user_id, kind)`.

### Tower assigned to multiple sessions

Race in `nextTowerExcluding` + `assignTower`. See `AUDIT.md` "High
Severity". Mitigation: serialize via Redis Lua or `SELECT ... FOR UPDATE`.

## Build scripts

### `build-plugin.ps1: KSP appears to be running`

Close KSP. Unity holds the DLL handle.

### `build-plugin.ps1: GameData/KSCTowerNetwork has unexpected entries: ...`

Something not in the allowlist (`Plugins`, `Patches`, `Props`,
`PluginData`, `Localization`, `Scripts`) is in the mod root. Move or
remove it. The check is intentional — it stops source files leaking into
shipped builds.

### `build-bridge-runtime.ps1: NodeExePath not found`

Pass `-NodeExePath "C:\Program Files\nodejs\node.exe"` (or wherever your
Node 22+ install lives).

## When in doubt

1. Check `backend` stdout for stack traces.
2. Check `<KSP>/KSP.log` for `KSCTowerNetwork` lines.
3. Check the bridge log (its own stdout, captured by `start-bridge.cmd`
   into `<KSP>/bridge.log` if redirected).
4. Open the web SPA's browser console.
5. Verify `curl https://api.example.com/v1/health` from an external IP.

## EADDRINUSE with no visible listener under WSL

WSL mirrored networking can reserve Linux ephemeral TCP ports without an
ordinary Windows listener. Check the Linux range with
`wsl -d Ubuntu -- cat /proc/sys/net/ipv4/ip_local_port_range` (use your distro
name). Choose available ports outside that range in ignored
`KSCTowerNetwork-dev/dev-ports.local.json`, then restart `npm run dev`.
Match the plugin listen/control ports and bridge environment settings. See
[DEVELOPMENT.md](DEVELOPMENT.md#persistent-local-development-ports) for the
configuration and [Microsoft WSL issue 40169](https://github.com/microsoft/WSL/issues/40169)
for the reservation behavior.
