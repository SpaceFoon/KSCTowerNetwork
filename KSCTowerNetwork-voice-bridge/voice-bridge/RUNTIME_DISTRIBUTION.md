# KSCTowerNetwork — End-User Distribution

This document is the authoritative recipe for building a release that an end
user can drop into `Kerbal Space Program/GameData/` and have *just work*.

## What ships, and where

A release ZIP contains exactly one top-level folder:

```
GameData/
  KSCTowerNetwork/
    KSCTowerNetwork.version          (CKAN/AVC version file)
    Plugins/
      KSCTowerNetwork.Client.dll     (compiled C# plugin)
    Props/RPM/...                    (RasterPropMonitor IVA props)
    Parts/...                        (any custom parts)
    web/dist/                        (optional: bundled tower web for offline use)
    PluginData/
      settings.example.cfg           (template, never overwritten)
      settings.cfg                   (working copy, edited by user)
      bridge-runtime/
        start-bridge.cmd
        README.txt
        node/
          node.exe                   (Windows x64 portable runtime, ~70 MB)
        app/
          dist/bridge.js
          node_modules/...           (production deps only)
```

Anything outside `GameData/KSCTowerNetwork/` (this repo's `KSCTowerNetwork-voice-bridge/`,
the backend source, the web source) **must not** be in the ZIP — it is dev-only.

## One-shot build

From `KSCTowerNetwork-voice-bridge/voice-bridge`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-bridge-runtime.ps1 `
  -NodeExePath "C:\Users\<you>\AppData\Local\nvm\v24.11.1\node.exe"
```

This:

1. Runs `npm run build` in the bridge source tree (`tsc -p tsconfig.build.json`).
2. Copies `package.json`, `package-lock.json`, and `dist/` into
   `GameData/KSCTowerNetwork/PluginData/bridge-runtime/app/`.
3. Runs `npm ci --omit=dev` inside that staged app to install **production-only**
   `node_modules` (currently just `@livekit/rtc-node`).
4. Copies the supplied `node.exe` into
   `GameData/KSCTowerNetwork/PluginData/bridge-runtime/node/node.exe`.
5. Writes a hardened `start-bridge.cmd` that fails fast with a readable error
   if `node.exe` or `app/dist/bridge.js` is missing at run time.

> The portable Node binary you point `-NodeExePath` at must be Windows x64.
> Grab one from `https://nodejs.org/dist/<version>/win-x64/node.exe` if you do
> not have one installed locally.

## Verify a build before shipping

Sanity checks that catch the common breakages:

```powershell
$root = "GameData\KSCTowerNetwork\PluginData\bridge-runtime"
Test-Path "$root\node\node.exe"          # must be True
Test-Path "$root\app\dist\bridge.js"     # must be True
Test-Path "$root\start-bridge.cmd"       # must be True
& "$root\start-bridge.cmd"               # bridge boots, prints
                                         #   [voice-bridge] PCM TCP 127.0.0.1:47372 ...
                                         # If the backend isn't up you'll see
                                         #   token fetch attempt 1/40 failed
                                         # That's expected without a backend.
```

If `node\node.exe` is missing the bridge will refuse to start with exit code 87
and a clear instruction to either rerun the build script or drop a node.exe in.

## Backend + web (the part that is NOT on the player's PC)

The bridge cannot work alone. It needs:

1. **A reachable backend** that issues LiveKit tokens at
   `POST {TOWER_API_BASE}/session/{SESSION_ID}/livekit-token`.
2. **A reachable tower web app** that the player opens in a browser to actually
   hear the pilot and key the mic.
3. **A LiveKit Cloud project** for the realtime audio transport.

There are two viable models — pick one before publishing:

### Model A — Community-hosted (closest to "just works")

- You run one backend (Railway / Fly / VPS) with the LiveKit secrets.
- You run one web frontend (Vercel / Netlify / Cloudflare Pages).
- You publish the URL on the forum/CKAN listing.
- Players install the GameData ZIP, edit `settings.cfg` once:

  ```
  towerApiHost = api.your-domain.example
  towerApiPort = 443
  towerApiTls  = True
  ```

- They open `https://tower.your-domain.example/` in any browser.
- Multiple players can talk on the same `sessionId`.

See `GameData/KSCTowerNetwork/PRODUCTION_DEPLOYMENT_PLAN.md` for the deploy
recipe (env vars, CORS, HTTPS, Clerk vs bearer auth, database).

### Model B — Self-hosted single-player

- Ship the backend bundled (also via a portable Node runtime under
  `PluginData/backend-runtime/`).
- Ship the prebuilt `web/dist/` bundle and serve it from the bundled backend.
- Have the C# plugin auto-spawn the backend the same way it auto-spawns the
  bridge.
- Player installs the ZIP, launches KSP, opens `http://127.0.0.1:48787/` in a
  local browser. No internet account required, no other players.
- LiveKit Cloud credentials still have to come from somewhere — either ship a
  rate-limited shared dev key (bad), or have each user sign up for the free
  tier and paste their own key into `settings.cfg` (annoying but honest).

Model A + Model B can coexist: ship the bundled self-host as the default and
let `settings.cfg` redirect to a community server.

## What the dev `npm run dev` flow is, and why it is NOT what end users get

`npm run dev` from `GameData/KSCTowerNetwork/` uses `concurrently` to spawn
backend, web (Vite), and bridge from source via `tsx watch`. It is a
developer-loop convenience and:

- Does **not** set `KSP_WATCHDOG=1`, so the bridge stays in the LiveKit room
  forever (showing as `ksp_bridge — idle` even when KSP is closed). Quitting
  the dev script (Ctrl+C) tears it down.
- Bypasses the bundled `node.exe` and the `start-bridge.cmd` launcher entirely.
- Reads source files from `KSCTowerNetwork-voice-bridge/voice-bridge/src/`,
  which are not in the release ZIP.

End users never run `npm run dev`. They only ever see the launcher invoked by
`TowerVoiceBridgeLauncher` at KSP start.

## Release integrity

For a forum/CKAN release, publish SHA256 hashes alongside the ZIP — at minimum
for `node/node.exe` (the largest single file and the one most worth verifying
since it's a binary) and the `KSCTowerNetwork.Client.dll`.

```powershell
Get-FileHash GameData\KSCTowerNetwork\PluginData\bridge-runtime\node\node.exe `
  -Algorithm SHA256
Get-FileHash GameData\KSCTowerNetwork\Plugins\KSCTowerNetwork.Client.dll `
  -Algorithm SHA256
```
