# Development

For **server hosting only**, use [SERVER_HOSTING.md](SERVER_HOSTING.md): the Bash/PowerShell server commands avoid the player bridge and Windows-only plugin build. The development commands below also run player-side components.

## Prerequisites

- **Node 22+** (matches the bundled bridge runtime).
- **PowerShell 7+** for the build scripts. Windows-only path: KSP is
  Win32-shaped, the C# build script invokes `csc.exe`/`dotnet`, and the
  bridge ships portable Windows `node.exe`.
- A Kerbal Space Program install with the `KSCTowerNetwork` mod installed
  under `GameData/`.
- (Optional) MariaDB and Redis. Without them, the backend runs with
  `DEV_IN_MEMORY=true`.

## Source checkout

This repository stores source and runtime templates. Build the plugin DLL and
bridge runtime locally using the commands in AGENTS.md. Copy
GameData/KSCTowerNetwork/PluginData/settings.example.cfg to settings.cfg if
needed; per-install settings and invite/user stores are ignored. Charts are optional and downloaded separately by the server owner; see [chart installation](AEROCHART_REFERENCE.md). Font binaries are excluded. See [repository setup](../../REPOSITORY_SETUP.md).

## First-time setup

```powershell
# From KSCTowerNetwork-dev/
npm run install
```

That one command installs dependencies for the root workspace, backend, web, and
voice bridge; copies `.env.example` → `.env.development` when those files are
missing; and on Windows downloads the pinned **Node v24 win-x64** into
`GameData/KSCTowerNetwork/PluginData/bridge-runtime/node/node.exe` (not in Git —
GitHub size limits / AV).

Plain `npm install` also works — npm runs the same `install` script after root
deps are fetched.

Prerequisites: **Node 22+** (voice bridge targets 24+), **PowerShell 7+** on
Windows for plugin build scripts.

Then start everything:

```powershell
npm run dev
```

`backend/.env.development` is local-only (gitignored). Copy from
`.env.example` if missing, then put your LiveKit keys there. Relevant presets:

```
NODE_ENV=development
DEV_OPEN_AUTH=true
DEV_USER_ID=admin@ksc.local
DEV_USER_ROLE=owner
DEV_DEFAULT_WEB_USER=true
DEV_VOICE_IDENTITY_HEADER=x-ksc-voice-identity
OWNER_USER_ID=admin@ksc.local
APP_JWT_SECRET=dev-only-change-me-please-please-please
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_WS_URL=wss://your-project.livekit.cloud
```

## Running everything

This starts three services in parallel via `concurrently` 10 (Node 22+). The launcher uses the CLI with explicit service names and colors; the v10 ESM-only API and removed deprecated options do not require script changes:

| Service | Port | URL |
|---|---|---|
| Backend (`tsx watch`) | 48787 | http://127.0.0.1:48787/v1/health |
| Web (`vite dev`) | 45173 | http://127.0.0.1:45173 |
| Voice bridge (`tsx watch`) | 47372 / 47373 | (TCP only) |

Or individually:

```powershell
npm run dev:backend
npm run dev:web
npm run dev:bridge
```

## Default dev logins

From `backend/.env.development` `WEB_LOGIN_USERS_JSON` (or the
`DEV_DEFAULT_WEB_USER` fallback):

| Email | Password | Role |
|---|---|---|
| `admin@ksc.local` | `admin12345` | owner |
| `controller@ksc.local` | `controller12345` | controller |
| `pilot@ksc.local` | `pilot12345` | pilot |

## Testing two roles in one browser

Open two **separate browser profiles** (or one regular + one private
window) and log in as different users. The `tower_web` JWT in
`localStorage` is per-profile, so this gives you two independent sessions
hitting the same backend.

For a quick **bridge identity** override without spinning up a real
plugin, set the dev voice header in your fetch:

```js
fetch("/v1/session/dev-shared/livekit-token", {
  method: "POST",
  headers: { "x-ksc-voice-identity": "ksp_bridge" }
});
```

## Building the plugin

KSP must be **closed**.

```powershell
cd KSCTowerNetwork-dev
.\build-plugin.ps1
```

The script:

1. Refuses to run if KSP is open.
2. Validates `GameData/KSCTowerNetwork/` only contains
   `Plugins/`/`Patches/`/`Props/`/`PluginData/`/`Localization/`/`Scripts/`.
3. Compiles `PluginSrc/*.cs` against `<KSP>/KSP_x64_Data/Managed/*.dll`.
4. Drops `KSCTowerNetwork.Client.dll` into `Plugins/`.

Open KSP and the plugin loads automatically.

### Plugin listen-UI unit tests (no KSP)

Pure annunciator rules live in `PluginSrc/TowerVoiceListenUiLogic.cs` and are
exercised by `plugin-tests/run-listen-ui-tests.ps1`. From `KSCTowerNetwork-dev/`:

```bash
npm run test:plugin-listen-ui
```

See [PLUGIN.md → Automated tests](PLUGIN.md#automated-tests-listen-ui-logic).

## Building the bridge runtime

Whenever you change `bridge.ts` or want to refresh the bundled `node.exe`:

```powershell
cd KSCTowerNetwork-voice-bridge\voice-bridge
.\scripts\build-bridge-runtime.ps1 -NodeExePath "C:\Program Files\nodejs\node.exe"
```

This produces a self-contained
`GameData/KSCTowerNetwork/PluginData/bridge-runtime/` with `node`, the
compiled bridge, native deps, and `start-bridge.cmd`.

For a quick TS-only rebuild without re-bundling node:

```powershell
npm run build
```

## Building a release ZIP

```powershell
cd KSCTowerNetwork-voice-bridge\voice-bridge
.\scripts\package-release.ps1
```

Reads `release-config.json` for the deployment URLs. Output ZIP contains
the full `GameData/KSCTowerNetwork/` tree ready to drop into a player's
KSP install.

## Linting / typecheck

```powershell
cd backend && npx tsc --noEmit
cd ..\web && npm run typecheck
cd ..\..\KSCTowerNetwork-voice-bridge\voice-bridge && npx tsc --noEmit
```

The web build runs `npm run typecheck` before Vite bundles the app, so TypeScript
errors fail the build. Run `npm test --prefix web` from the dev workspace for the
web regression suite. There's no global lint runner; rely on TS's strict mode +
the editor's inline diagnostics.

## Mutation testing (tower logic)

Pure tower derivation modules under `backend/src/tower/` are held to **≥80%**
mutation score via [Stryker](https://stryker-mutator.io/). Scope and threshold
live in `backend/stryker.config.json`. Rule intent and telemetry flow are
documented in [`TOWER_LOGIC.md`](TOWER_LOGIC.md).

```powershell
# From KSCTowerNetwork-dev/
npm run test:mutation

# Or directly in backend/
cd backend
npm run test:mutation
```

The HTML report is written to `backend/reports/mutation/mutation.html` (~5 min
on a typical laptop). Unit tests alone:

```powershell
cd backend
node --import tsx --test src/tower/*.test.ts
```

## Hot-reload behavior

| Service | Reload trigger |
|---|---|
| Backend | `tsx watch` restarts on `.ts`/`.json` change. State (in-memory) is lost. |
| Web | Vite HMR, no full reload for component changes. |
| Bridge | `tsx watch` restart. KSP's plugin will reconnect on the next PCM/control retry tick. |

## Resetting state

In-memory mode: just restart the backend.

MariaDB mode: drop and recreate the database; migrations re-run on boot:

```sql
DROP DATABASE ksc_tower;
CREATE DATABASE ksc_tower;
```

Redis mode: `FLUSHDB` against the configured `REDIS_URL`.

## Useful one-liners

```powershell
# Tail backend log:
npm run dev:backend

# Curl health:
curl http://127.0.0.1:48787/v1/health

# Mint a guest token (bypassing the UI):
curl -X POST http://127.0.0.1:48787/v1/auth/guest -H 'Content-Type: application/json' -d '{}'

# List active sessions as admin (dev-open):
curl http://127.0.0.1:48787/v1/lobby/rooms

# See every route in api.ts:
rg "apiRouter\.(get|post|put|patch|delete)" backend/src/routes/api.ts
```

## Flightwall validation

From `web/`, run `npm.cmd test -- src/tower/flightWallGuidance.test.ts
src/tower/towerAircraftTracks.test.ts`, then `npm.cmd run build`. Start Vite
and open `/flightwall-preview.html` to inspect selectable tracks, zoom/reset,
Traffic/Stale/No traffic states and the stacked narrow layout.

From `backend/`, run `node --import tsx --test
src/integration/craftThumbnail.http.integration.test.ts` and
`npm.cmd run typecheck`. The HTTP test covers pilot-only publication,
controller/member reading, invalid/oversized images, craft changes, session
closure and thumbnail expiration.

From the dev root, run `powershell.exe -NoProfile -ExecutionPolicy Bypass
-File .\plugin-tests\run-craft-thumbnail-tests.ps1` for exact thumbnail lookup,
save isolation, missing names and traversal rejection. Rebuild the plugin
with `build-plugin.ps1`; an external game install can provide its assemblies
through `-KspManagedPath` (output remains in the repository).

In-game acceptance still requires a pilot to fly a saved craft with its
beacon enabled and the rebuilt DLL, confirm the correct editor thumbnail on
the web Flightwall, then switch to a differently named craft and confirm the
old image disappears. Compilation and local HTTP tests do not prove that
live KSP-to-browser path.

## Moving an existing local checkout

Keep the legacy checkout until the new checkout has passed local login,
voice and in-game telemetry checks. Ignored configuration does not travel
with a clone: preserve backend/web dotenv files, plugin settings/auth,
local invite/user stores, release configuration and optional fonts/maps.
Keep backups before replacing configuration, and keep all private files
ignored. Dependency directories and generated runtime output must belong
to the new checkout rather than junctions into the legacy checkout.

For a source checkout outside KSP, build against the game's assemblies:

```powershell
# From KSCTowerNetwork-dev/, with KSP closed:
.\build-plugin.ps1 -KspManagedPath '<KSP install>\KSP_x64_Data\Managed'
```

The compiler response file supports both Windows PowerShell and PowerShell
7, including paths with spaces. The DLL is written to the checkout's
`GameData/`, not automatically installed into the external game directory.

Backend `npm test` preloads `backend/test/setup.cjs` before TypeScript imports.
It selects test mode, in-memory persistence and dummy signing settings, and
clears LiveKit credentials. The env loader skips local dotenv files for
`NODE_ENV=test` and Node test-runner children. Integration tests release
MariaDB/Redis handles on completion. This keeps personal dev configuration
from overriding fixtures or making tests contact the owner's LiveKit project.

If Windows rejects the default ports with EADDRINUSE while netstat shows no
listener, diagnose the machine's sockets/reservations. Temporary checks can
use explicit localhost ports in separate terminals:

```powershell
# From web/, backend running on 48787:
node .\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 48800

# From KSCTowerNetwork-voice-bridge/voice-bridge/:
$env:PCM_PORT = '48801'
$env:CTL_PORT = '48802'
node .\dist\bridge.js
```

These commands do not change the normal ports. In-game checks on alternate
ports also require matching `voiceListenPort`/`voiceCtlPort` in the game's
local settings; temporary TCP startup alone does not prove game audio works.

The migrated owner's chart source is in ignored `.local-assets/`. After a
web build, install charts again before serving the built app:

```powershell
# From web/:
.\scripts\install-charts.ps1 -PdfPath '..\..\.local-assets\Kerbin_AEROCHARTS-25-nov-2017.pdf'
node .\node_modules\vite\bin\vite.js preview --host 127.0.0.1 --port 48803 --strictPort
```