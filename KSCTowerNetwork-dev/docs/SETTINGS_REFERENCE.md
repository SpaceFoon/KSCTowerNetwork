# Settings Reference

Five places where configuration lives. **Source of truth column** says
which file owns the value — don't duplicate it elsewhere.

| File | Owner | Edited by |
|---|---|---|
| `backend/.env` | Backend | Operator (server-side). |
| `backend/.env.development` | Backend in dev | Devs. Loaded only when `NODE_ENV !== production`. |
| `web/.env` (`VITE_*`) | Web SPA build | Devs/operator. |
| `GameData/KSCTowerNetwork/PluginData/settings.cfg` | KSP plugin | End users (per-install). |
| `GameData/KSCTowerNetwork/PluginData/auth.cfg` | KSP plugin | Plugin (do not hand-edit). |
| `KSCTowerNetwork-dev/release-config.json` | Release packager | Distributor (one per release). |

## Backend env

Schema: `backend/src/config/env.ts` (Zod). Production guards reject every
`DEV_*` flag.

### Core

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Standard. `production` enables strict guards. |
| `PORT` | `48787` | Backend HTTP port. |
| `APP_JWT_SECRET` | dev fallback | **Must override in prod.** Min 16 chars. |
| `APP_JWT_EXPIRES_IN_SECONDS` | `604800` (7 d) | TTL for `tower_web` and `guest` JWTs. `plugin_session` is exempt. |
| `OWNER_USER_ID` | unset | Pins exactly one user as owner. Cannot be banned/demoted. |
| `CORS_ORIGINS` | dev: localhost; prod: empty | Comma-separated allowlist. `*` disables credentials. |

### Persistence

| Var | Default | Notes |
|---|---|---|
| `MARIADB_HOST` | `127.0.0.1` | |
| `MARIADB_PORT` | `3306` | |
| `MARIADB_USER` | `root` | |
| `MARIADB_PASSWORD` | empty | |
| `MARIADB_DATABASE` | `ksc_tower` | |
| `REDIS_URL` | `redis://127.0.0.1:6379` | |

### LiveKit

| Var | Default | Notes |
|---|---|---|
| `LIVEKIT_API_KEY` | unset | Required for voice. |
| `LIVEKIT_API_SECRET` | unset | Required for voice. |
| `LIVEKIT_WS_URL` | unset | Browser-facing wss URL. |
| `LIVEKIT_URL` | unset | Fallback for dashboards that use this name. Placeholders containing `example.com` are ignored. |
| `LIVEKIT_BRIDGE_IDENTITIES` | `ksp_bridge` | Comma-separated identities treated as the voice bridge (subscribe-only, clean display name). |
| `LIVEKIT_BRIDGE_DISPLAY_NAME` | `Kerbal Space Program (voice bridge)` | What other participants see. |

### Telemetry

| Var | Default | Notes |
|---|---|---|
| `TELEMETRY_DEFAULT_SECONDS` | `5` | Adaptive default. Pilot polls at this rate. |
| `TELEMETRY_CLOSE_SECONDS` | `1` | Faster polling near runway. |
| `TELEMETRY_CLOSE_AGL_M` | `15000` | "Close" threshold in metres AGL. |
| `PILOT_IDLE_CLOSE_SECONDS` | `120` | Soft-close tower sessions when the last telemetry sample is older than this many seconds (same as lobby **Close**). `0` disables. Skips `dev-shared`, `ksc-radio-*`, `KSC-TOWER-*`, and sessions that never received telemetry. |
| `PILOT_IDLE_SWEEP_INTERVAL_SECONDS` | `30` | How often the backend runs the idle check (5–600). Ignored when `PILOT_IDLE_CLOSE_SECONDS` is `0`. |

### Live transport (HTTP WebSocket + UDP ingest)

Used by `backend/src/live/wsTransport.ts` and `backend/src/live/udpWorker.ts`.
See [ARCHITECTURE.md → Ports, firewall, live transport](ARCHITECTURE.md#ports-firewall-and-live-transport) and [PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md).

| Var | Default | Notes |
|---|---|---|
| `LIVE_WS_ENABLED` | `true` | `false` disables the WebSocket live transport (browser falls back to HTTP polling where implemented). |
| `LIVE_WS_PATH` | `/v1/live/ws` | Path on the **same HTTP server** as Express; upgraded by `ws`. |
| `LIVE_UDP_ENABLED` | `true` | `false` disables the UDP listener (KSP must use HTTP fallback for live frames). |
| `LIVE_UDP_HOST` | `0.0.0.0` | UDP bind address (`127.0.0.1` if you only want loopback pilots). |
| `LIVE_UDP_PORT` | `48788` | **Must match** plugin `liveUdpPort` when the pilot aims at this host. |
| `LIVE_UDP_MAX_PACKET_BYTES` | `8192` | Datagrams larger than this are dropped before decode. |

### ATIS (Phase 1: text + API; TTS/audio later)

| Var | Default | Notes |
|---|---|---|
| `ATIS_WEATHER_PATH` | `./data/atis.weather.json` | Relative to backend process cwd (`backend/` when using npm scripts). |
| `ATIS_MODE` | `weather` | `weather` = minimal observation; `roleplay` = adds modular advisories/disclaimer/closer lines. |
| `ATIS_TICK_SECONDS` | `30` | How often the service re-reads the file and recomposes broadcast lines. |
| `ATIS_MIN_ADVANCE_SECONDS` | `60` | Floor between NATO letter advances; use `0` in dev to test advances immediately. |
| `ATIS_ROLEPLAY_INCLUDE_NOTAM_ADVISORIES` | `true` | In roleplay mode, convert NOTAM text into 1-3 short `Advisory ...` lines. |
| `ATIS_ROLEPLAY_MAX_NOTAM_ADVISORIES` | `2` | Cap for NOTAM-derived advisory lines (range 1..3). |
| `ATIS_ROLEPLAY_INCLUDE_FIELD_STATUS` | `true` | In roleplay mode, append one short randomized field-status line (pattern/training/ground ops). |
| `ATIS_ROLEPLAY_INCLUDE_DISCLAIMER` | `true` | Adds `Advisory only. Tower clearance required.` in roleplay mode. |
| `ATIS_ROLEPLAY_INCLUDE_CLOSER` | `true` | Adds concise closer `Information <letter>.` in roleplay mode. |

### Web login

| Var | Default | Notes |
|---|---|---|
| `WEB_LOGIN_USERS_JSON` | unset | JSON: `[{ "email": "...", "passwordHash": "...", "role": "...", "userId": "..." }]`. **Must be set in prod.** |
| `DEV_DEFAULT_WEB_USER` | `false` | Dev only. Allows the built-in `tower@ksc.local`/`tower12345` fallback. Throws in prod. |

### Clerk (optional)

| Var | Default | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | unset | Enables Clerk-issued tokens via `verifyToken`. |
| `CLERK_JWT_KEY` | unset | Public key for Clerk verification. |

### Dev / debug (all forbidden in prod)

| Var | Default | Notes |
|---|---|---|
| `DEV_OPEN_AUTH` | `false` | Skip external auth; use `DEV_USER_ID`. **Throws in prod.** |
| `DEV_BEARER_SECRET` | unset | Static shared bearer (≥20 chars). Constant-time compared. **Throws in prod.** |
| `DEV_USER_ID` | `dev_local` | Identity used when dev-open auth wins. |
| `DEV_USER_ROLE` | `owner` | Role for the dev principal. Legacy names (`tower`/`supervisor`/`admin`) are auto-translated. |
| `DEV_VOICE_IDENTITY_HEADER` | unset | Header name (e.g. `x-ksc-voice-identity`) that overrides `DEV_USER_ID` per request. **Throws in prod.** |
| `DEV_IN_MEMORY` | `false` | Force in-memory persistence even if DB is reachable. **Throws in prod.** |

## Web env (`web/.env`)

| Var | Notes |
|---|---|
| `VITE_API_BASE` | Optional API origin. Empty = relative `/v1` (same-origin nginx layout). |
| `VITE_LIVEKIT_WS_URL` | Optional client-side override. Backend-issued tokens already include the wsUrl in the response. |

Vite only exposes vars prefixed `VITE_`.

## Plugin `settings.cfg`

Lives at `GameData/KSCTowerNetwork/PluginData/settings.cfg`. Template:
`settings.example.cfg`. **`settings.cfg` is gitignored** so player edits
survive mod updates.

Top-level node: `KSCTOWERNETWORK { … }`. Keys:

### Backend connection

| Key | Default | Notes |
|---|---|---|
| `towerApiHost` | `127.0.0.1` | Hostname only. **Do not include scheme**; KSP's ConfigNode parser treats `//` as a comment. |
| `towerApiPort` | `48787` | `443` for TLS. |
| `towerApiPath` | `/v1` | |
| `towerApiTls` | `False` | `True` to use `https`/`wss`. |

### Live UDP transport (plugin)

Mirrors **`LIVE_UDP_*`** on the backend. Defaults match a **loopback** dev
machine (`127.0.0.1:48788`). Remote pilots must use a reachable **`liveUdpHost`**
and open **UDP** to **`liveUdpPort`** on the tower host (see
[ARCHITECTURE.md → Ports, firewall, live transport](ARCHITECTURE.md#ports-firewall-and-live-transport)).

| Key | Default | Notes |
|---|---|---|
| `useUdpLiveTransport` | `True` | When `True`, telemetry / ghost-fleet style traffic prefers UDP before HTTP. |
| `liveUdpHost` | `127.0.0.1` | Target for UDP datagrams (often same host as `towerApiHost`). |
| `liveUdpPort` | `48788` | Must match backend `LIVE_UDP_PORT`. |
| `liveUdpTimeoutMs` | `500` | Send timeout; clamped `100..30000` at load. |
| `liveUdpFallbackHttp` | `True` | When `True`, failed UDP attempts retry over normal HTTPS/HTTP routes. |

### Session

| Key | Default | Notes |
|---|---|---|
| `sessionId` | `dev-shared` | Backend room name suffix. |

### Local voice plumbing

| Key | Default | Notes |
|---|---|---|
| `voiceListenHost` | `127.0.0.1` | Bridge → KSP PCM. |
| `voiceListenPort` | `47372` | |
| `voiceListenVolume` | *(unset)* | Optional **0…1** helmet listen gain seed (`1` = full). Read when `settings.cfg` loads; then **Plugin `auth.cfg`** (below) is merged and **overrides** this key when `voiceListenVolume` exists there (typical after the player uses the in-game **VOL** button). If `settings.cfg` is missing or unreadable, in-memory defaults apply and **`auth.cfg` is still loaded** so volume and JWT persist. |
| `voiceCtlHost` | `127.0.0.1` | KSP → bridge control. |
| `voiceCtlPort` | `47373` | |

### UX

| Key | Default | Notes |
|---|---|---|
| `pushToTalkKey` | `R` | KeyCode name. |
| `skipTowerLogin` | `False` | If `True`, plugin runs as guest only (no login UI). |
| `rememberTowerEmail` | `True` | Pre-fills email field. |
| `persistTowerSessionToken` | `True` | Save `plugin_session` JWT to `auth.cfg` via `TowerSecureStore`. |
| `autoConnectDelaySeconds` | `2.5` | Delay before auto voice connect (seconds, clamped `0..60` at load). |
| `autoConnectVoiceListen` | `True` | Auto-open the PCM downlink at game start. |
| `autoBridgeMicAfterListen` | `False` | Auto-arm PTT path after listen connects (rare). |
| `blockChattererInFlight` | `False` | When `True`, Chatterer + ASET `ATC_*` clips stay muted for the entire Flight scene (`TowerChattererDuck`). When `False`, only PTT-based ducking applies. |

### Voice bridge auto-launch

| Key | Default | Notes |
|---|---|---|
| `autoStartVoiceBridge` | `True` | |
| `bridgeExecutable` | `GameData/KSCTowerNetwork/PluginData/bridge-runtime/start-bridge.cmd` | |
| `bridgeWorkingDirectory` | `GameData/KSCTowerNetwork/PluginData/bridge-runtime` | |
| `bridgeArguments` | empty | |
| `bridgeEnv_*` | none | Each `bridgeEnv_KEY = VAL` becomes an env var on the spawned process. The runtime expects at least `bridgeEnv_BRIDGE_IDENTITY = ksp_bridge`. |

### HullCam relay

Bridges JRTI's local HTTP listener into the tower backend. See
[BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline) for the
server-side limits these knobs interact with.

| Key | Default | Notes |
|---|---|---|
| `enableHullCamRelay` | `False` | Master toggle. Off by default — opt-in because it touches an external mod and consumes uplink. Player-facing on/off is the **HULL** switch on the cockpit radio panel, persisted to `auth.cfg`. |
| `hullCamFps` | `1` | Snapshot cadence. Clamped to `1..2` at load. The backend rate-limits to `5 fps/user` server-side regardless. |
| `hullCamJrtiBaseUrl` | `http://127.0.0.1:8080` | JRTI's **local HTTP** listener (`StreamPort` in JRTI's settings). Must be a URL that passes `LooksLikeHttpUrl` — in practice that is **`http://` on loopback** because JRTI does not offer HTTPS. This is unrelated to whether your **tower `ApiBaseUrl`** is `https://` in production. Quote the value or use the `host`/`port`/`path` style — KSP's ConfigNode parser strips after `//`. |
| `hullCamMaxBytes` | `192000` | Plugin-side ceiling on per-frame upload; oversize frames are dropped client-side so we don't round-trip a payload the backend will 413 anyway. Valid range `8000..524288` (8 KB to 512 KB). The **server** caps incoming bodies at 192 KB regardless — leaving headroom above that here is harmless but pointless. |

### kOS bridge

| Key | Default | Notes |
|---|---|---|
| `kosBridgeEnabled` | `True` | Set `False` to fully disable kOS Archive reads/writes. |
| `kosBridgeArchivePath` | `Ships/Script` | Folder under the kOS Archive root. Used by the ACARS bridge. |
| `kosBridgeAutoInstallScript` | `True` | Drops `acars.ks` / `acars_lib.ks` once. |
| `kosBridgePollSeconds` | `3` | ACARS mailbox poll cadence. |

### kOS screen mirror

Hands-free auto-capture — `TowerKosScreenAutoCapture` reflectively walks every
active `kOS.Module.kOSProcessor` part each tick and forwards changed terminal
lines to the web Tower desk's `KosScreenPanel`. No script-side opt-in, no
mailbox file. See [PLUGIN.md](PLUGIN.md#kos-screen-mirror) for the diff /
dedupe / reflection details.

There's no `settings.cfg` knob for this in the typical install — the player-facing
on/off is the **KOS** switch on the cockpit radio panel, persisted to `auth.cfg`
as `kosScreenStreamActive` (defaults true). For headless / scripted setups you
can pre-seed the value in `settings.cfg`:

| Key | Default | Notes |
|---|---|---|
| `kosScreenStreamActive` | `True` | Initial state of the cockpit KOS toggle. Set `False` to start with the kOS-screen mirror off. The legacy key `kosScreenEnabled` is still read as a fallback so older `settings.cfg` files keep working. |

## Plugin `auth.cfg`

Generated by the plugin. Holds the encrypted `plugin_session` JWT and
metadata (last-known display name, owner email). **Do not hand-edit.**
Delete to force re-pairing.

The plugin also persists **player cockpit toggles** and similar preferences
here (same `KSCTOWERNETWORK_AUTH` node) so they survive restarts without
rewriting the user’s commented `settings.cfg`. Relevant to the radio panel:

| Key | Typical range | Notes |
|-----|-----------------|-------|
| `voiceListenVolume` | `0` … `1` | Helmet **tower voice** PCM level (`TowerVoicePlayback` `AudioSource.volume`). Changed in-game with the **VOL** button on the radio panel (`TowerRadioGui`). |

Full radio UI behavior (procedural MHz LCD, 25 kHz COM snap, VOL): [`TOWER_RADIO_UI.md`](TOWER_RADIO_UI.md).

## Release config (`release-config.json`)

Used by `scripts/package-release.ps1` to bake deployment URLs into the
end-user ZIP. Template: `release-config.example.json`.

| Key | Notes |
|---|---|
| `towerApiHost` / `towerApiPort` / `towerApiTls` / `towerApiPath` | Baked into the shipped `settings.cfg`. |
| `sessionId` | Default room. |
| `livekitUrl` | Bridge runtime env. |
| `bridgeIdentity` | Defaults to `ksp_bridge`. |
| `webBaseUrl` | Used in the in-game login GUI's "open browser" button. |

Never commit a populated `release-config.json` for someone else's
deployment. Only the example is checked in.
