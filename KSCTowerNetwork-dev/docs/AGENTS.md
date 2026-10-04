# Agent Guide — KSCTowerNetwork

> If you are an AI agent working in this repo, **read this whole file**, then
> open [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md), then dive into the
> relevant per-subsystem doc in this folder ([`README.md`](README.md) is the
> doc index). Treat `*_PLAN.md` files as **future** intent unless they
> describe testing/CI process.

## Doc map (read in this order)

1. **[`AGENTS.md`](AGENTS.md)** (this file) — rules + 60-second orientation.
2. **[`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)** — full file inventory and architecture.
3. **[`README.md`](README.md)** — per-subsystem deep-dives index:
   - [`ARCHITECTURE.md`](ARCHITECTURE.md) — diagrams, data flows, ports / firewall / UDP+WS.
   - [`PERFORMANCE_AND_HOT_PATHS.md`](PERFORMANCE_AND_HOT_PATHS.md) — hot routes, profiling, `/live/metrics`.
   - [`BACKEND.md`](BACKEND.md) — Express service.
   - [`TOWER_LOGIC.md`](TOWER_LOGIC.md) — shipped tower rules (`backend/src/tower/`).
   - [`WEB_SPA.md`](WEB_SPA.md) — React frontend.
   - [`PLUGIN.md`](PLUGIN.md) — KSP C# plugin.
   - [`TOWER_RADIO_UI.md`](TOWER_RADIO_UI.md) — cockpit radio MHz / 25 kHz COM / VOL / procedural LCD.
   - [`VOICE_BRIDGE.md`](VOICE_BRIDGE.md) — bridge protocol.
   - [`API_REFERENCE.md`](API_REFERENCE.md) — endpoints.
   - [`AUTH_AND_ROLES.md`](AUTH_AND_ROLES.md) — tokens, roles, capabilities.
   - [`SETTINGS_REFERENCE.md`](SETTINGS_REFERENCE.md) — every env var / cfg key.
   - [`DEVELOPMENT.md`](DEVELOPMENT.md) — local setup.
   - [`DEPLOYMENT.md`](DEPLOYMENT.md) — production deploy.
   - [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — symptom-first lookup.
   - [`GLOSSARY.md`](GLOSSARY.md) — terms & acronyms.
4. **[`AUDIT.md`](AUDIT.md)** — known foot guns. Skim before touching auth, persistence, or the bridge.
5. **[`TEST_COVERAGE_PLAN.md`](TEST_COVERAGE_PLAN.md)** — roadmap for automated tests (HTTP, auth, web, CI). Root pointer: [`../TEST_COVERAGE_PLAN.md`](../TEST_COVERAGE_PLAN.md).

## Repo orientation in 60 seconds

Three trees on one disk under `Kerbal Space Program/`:

1. **`GameData/KSCTowerNetwork/`** — what KSP actually loads. Compiled DLL,
   ModuleManager patches, IVA props, kOS scripts, `PluginData/` (settings +
   bundled bridge runtime with portable `node.exe`). **Do not put source code
   here.** `build-plugin.ps1` enforces this with a hygiene check that will
   fail the build if anything other than `Plugins/`, `Patches/`, `Props/`,
   `PluginData/`, `Localization/`, or `Scripts/` appears at the mod root.
2. **`KSCTowerNetwork-dev/`** — dev workspace. C# plugin sources (`PluginSrc/`),
   Express+TS backend (`backend/`), Vite+React web SPA (`web/`), build
   scripts, and every plan doc.
3. **`KSCTowerNetwork-voice-bridge/voice-bridge/`** — Node voice-bridge source
   and the scripts that build the runtime into (1) and package end-user ZIPs.
   Use the **inner** `voice-bridge/voice-bridge/`, not the outer one.

## What each component does

| Piece | Lang | Role |
|---|---|---|
| KSP plugin | C# (Unity) | In-game UI, telemetry POSTs, hull-cam relay, ACARS panel, voice playback (TCP PCM in), mic PTT (TCP control out), auto-spawn of the local bridge. |
| Voice bridge | Node + `@livekit/rtc-node` | Joins LiveKit room as identity `ksp_bridge`. Mixes remote audio → broadcasts s16le PCM on `127.0.0.1:47372`. Receives `MIC_ON/OFF` on `127.0.0.1:47373` and forwards as a LiveKit data-channel JSON packet that the web tab listens for. |
| Backend | Express + TypeScript | All HTTP at `/v1/*`. Auth (JWT + optional Clerk), session/queue lifecycle, telemetry ingest, hull-cam store, scoring, moderation, LiveKit token mint. MariaDB+Redis with in-memory fallback. |
| Web SPA | React + Vite + LiveKit JS | `/login`, `/lobby`, `/room/:id`, `/dm`, `/tower`, `/admin`. Outbound mic runs through the **Kerbalizer** DSP chain (AudioWorklet, biquad fallback). |

LiveKit **ops** room name is `tower-{sessionId}` (tower mix + bridge + eligible
web clients). Spectator **booth** commentary uses `tower-{sessionId}-booth`
(`POST .../livekit-token` with `{ "flavor": "booth" }`). The pilot's KSP
**never speaks WebRTC** — only HTTP (to backend) and TCP (to its local bridge).

## Authoritative docs (read before editing the matching subsystem)

- [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) — start here. File-by-file
  inventory, full HTTP API list, settings reference, deployment summary.
- [`AUDIT.md`](AUDIT.md) — known foot guns. Skim the **Critical** section
  before any change that touches auth, persistence, or the bridge.
- [`REAL_TOWER_ROADMAP.md`](REAL_TOWER_ROADMAP.md) — ATC mechanics roadmap.
- [`ROLEPLAY_FEATURES_CATALOG.md`](ROLEPLAY_FEATURES_CATALOG.md) — immersion
  features (squawk, callsigns, multi-role seats, ATIS, etc.).
- [`GHOSTS_AND_TOWER_VIEW_PLAN.md`](GHOSTS_AND_TOWER_VIEW_PLAN.md) — in-game
  ghost traffic + tower-view stream.
- [`TELEMETRY_AND_TOWER_TRACKING_PLAN.md`](TELEMETRY_AND_TOWER_TRACKING_PLAN.md)
- [`VOICE_IMPLEMENTATION_PLAN.md`](VOICE_IMPLEMENTATION_PLAN.md)
- [`ATIS_PLAN.md`](ATIS_PLAN.md)
- [`HOSTING.md`](HOSTING.md) and [`PRODUCTION_DEPLOYMENT_PLAN.md`](PRODUCTION_DEPLOYMENT_PLAN.md)
- `../KSCTowerNetwork-voice-bridge/voice-bridge/RUNTIME_DISTRIBUTION.md`

## Hard rules

1. **Never put non-runtime files under `GameData/KSCTowerNetwork/`.** Allowed
   subfolders only: `Plugins/`, `Patches/`, `Props/`, `PluginData/`,
   `Localization/`, `Scripts/`. `build-plugin.ps1` will fail otherwise.
2. **Do not regress the production env guards in `backend/src/config/env.ts`.**
   `DEV_OPEN_AUTH`, `DEV_BEARER_SECRET`, `DEV_VOICE_IDENTITY_HEADER`,
   `DEV_DEFAULT_WEB_USER`, `DEV_IN_MEMORY` must continue to throw at boot
   when `NODE_ENV=production`. `APP_JWT_SECRET` must continue to throw if
   left at the dev default in prod.
3. **Never call synchronous TCP from the Unity main thread.** Use
   `TowerVoiceBridgeControl.EnqueueSend(host, port, cmd, callback)`.
   Use `TowerMainThreadDispatcher.Run(action)` to bounce results back to the
   main thread for `ScreenMessages`/`Debug.Log`.
4. **Never widen CORS to `origin: true` with credentials.** Use the explicit
   allowlist in `backend/src/index.ts`.
5. **Comments**: only explain non-obvious intent, trade-offs, or constraints.
   Never narrate what the code does.
6. **Voice bridge identity** is `ksp_bridge` (or whatever
   `LIVEKIT_BRIDGE_IDENTITIES` lists). Token-mint code in the backend treats
   that identity specially — preserve the carve-out.
7. **Never commit a populated `release-config.json`** for someone else's
   deployment. Only the `release-config.example.json` template is checked in.

## Antivirus + agent hygiene (Windows)

- **Mod root allowlist is strict** (`../build-plugin.ps1` `Test-GameDataHygiene`).
  Do not add extra top-level folders under `GameData/KSCTowerNetwork/` (e.g. no
  `Crafts/`, `web/`, `node_modules/`). Ship loose text next to other plugin data
  under `PluginData/` only (example: `PluginData/TOWER_CAM_README.txt`).
- **Do not** drive `npm install`, bulk downloads, or `Invoke-WebRequest` into
  `GameData/` or deeper under `Program Files (x86)/Steam/` from automation unless
  the repo owner explicitly asked — AV often quarantines that activity.
- **Bundled bridge** installs include `node.exe` and `node_modules/` under
  `PluginData/bridge-runtime/` after `build-bridge-runtime.ps1` (not committed; root
  `.gitignore` ignores `**/node_modules/`). SmartScreen / Defender may flag it;
  fixing that is an OS exclusion or moving the **git clone** to a non-Steam path
  (e.g. `C:\src\Kerbal Space Program`), not duplicating another Node tree for tests.

## Common dev commands (PowerShell)

```powershell
# All three services with hot reload (from KSCTowerNetwork-dev/):
npm run dev            # backend 48787, web 45173, bridge 47372/47373

# Just one of them:
npm run dev:backend
npm run dev:web
npm run dev:bridge

# Compile the C# plugin into GameData (KSP must be CLOSED):
cd KSCTowerNetwork-dev
.\build-plugin.ps1

# Re-build the bundled bridge runtime under PluginData/bridge-runtime/:
cd KSCTowerNetwork-voice-bridge\voice-bridge
.\scripts\build-bridge-runtime.ps1 -NodeExePath "<path to node.exe>"

# Build a player-distributable release ZIP (reads release-config.json):
cd KSCTowerNetwork-voice-bridge\voice-bridge
.\scripts\package-release.ps1
```

## Default ports

| Port | Service |
|---|---|
| `48787` | backend HTTP |
| `45173` | Vite dev server (proxies `/v1` → 48787) |
| `47372` | bridge → KSP PCM downlink (TCP, s16le 48 kHz mono) |
| `47373` | KSP → bridge PTT control (TCP, line-based: `MIC_ON` / `MIC_OFF` / `PING`) |

## Default dev login presets (local `backend/.env.development`, from `.env.example`)

| Email | Password | Role |
|---|---|---|
| `admin@ksc.local` | `admin12345` | owner (also `OWNER_USER_ID`) |
| `controller@ksc.local` | `controller12345` | controller |
| `pilot@ksc.local` | `pilot12345` | pilot |

## When you finish a change

- Run `ReadLints` on the files you touched.
- If you edited C#, rebuild via `build-plugin.ps1` (KSP must be closed).
- If you edited the bridge, rebuild via `build-bridge-runtime.ps1`.
- Update `PROJECT_OVERVIEW.md` if you changed the file inventory, the env
  surface, the HTTP API, or the role/capability matrix.
- Don't create commits unless the user explicitly asks.
