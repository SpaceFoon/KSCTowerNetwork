# Voice Bridge

Tiny standalone Node process that owns the LiveKit room from the KSP
machine's side. Lives next to KSP, **not** on the server.

Source: `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts`
Built into: `GameData/KSCTowerNetwork/PluginData/bridge-runtime/app/dist/bridge.js`
Bundled with: a portable `node.exe` so end users don't install Node.
Launched by: KSP plugin (`TowerVoiceBridgeLauncher.cs`) via
`PluginData/bridge-runtime/start-bridge.cmd`.

## Why a separate process

`@livekit/rtc-node` is a native module that loads PortAudio along with its
own native segfault handler. Running it inside the same Unity process as
KSP crashed the game the moment the mic got published. Splitting it out
means:

- Crashes in the bridge can be auto-restarted without taking KSP down.
- Native audio bindings stay out of Unity's address space.
- The bridge can be updated independently of the C# plugin.

## What it actually does

1. Fetches a LiveKit token from the backend (`POST /v1/session/{id}/livekit-token`)
   using `x-ksc-voice-identity: ksp_bridge`.
2. Connects to LiveKit as participant `ksp_bridge`.
3. **Subscribe-only**: never publishes audio, never opens a mic.
4. Mixes all incoming remote audio tracks via `AudioMixer`
   (s16le, 48 kHz, 1 ch, 20 ms blocks).
5. **Listens on TCP `127.0.0.1:47372` (PCM downlink)** — every connected
   socket gets the mixed PCM stream broadcast to it. The KSP plugin's
   `TowerVoicePlayback` is the consumer.
6. **Listens on TCP `127.0.0.1:47373` (control uplink)** — accepts simple
   newline-delimited commands and translates them into LiveKit data-channel
   messages.

## Wire protocol

### PCM downlink (`PCM_PORT`, default `47372`)

- Server-style TCP. Bridge accepts, plugin connects.
- On accept, the bridge writes one ASCII banner line:
  ```
  TOWER_PCM s16le 48000 mono\n
  ```
- After the banner: continuous raw `Int16LE` mono samples at 48 kHz, no
  framing, no headers. ~960 samples per 20 ms block (the mixer's blocksize).
- No keepalive. The plugin should reconnect on EOF.

### Control uplink (`CTL_PORT`, default `47373`)

- Server-style TCP. Bridge accepts, plugin connects.
- Newline-terminated commands, ASCII:

| Sent (plugin → bridge) | Reply | Effect |
|---|---|---|
| `PING\n` | `PONG\n` | Heartbeat / liveness check. |
| `MIC_ON\n` | `OK mic_on\n` or `ERR …\n` | Bridge publishes `{ type:"ksp_ptt", on:true, from:"ksp_bridge" }` on the LiveKit reliable data channel. |
| `MIC_OFF\n` | `OK mic_off\n` or `ERR …\n` | Same with `on:false`. |
| anything else | `ERR unknown command\n` | — |

The data-channel packet is the only reason the bridge talks to LiveKit
**outbound** at all. The actual audio for the pilot's voice is published
by the **tower's browser tab** when it sees this packet.

## LiveKit data-channel contract

```json
{ "type": "ksp_ptt", "on": true,  "from": "ksp_bridge" }
{ "type": "ksp_ptt", "on": false, "from": "ksp_bridge" }
```

Sent with `reliable: true`. Don't change `type` without updating the
listener in the web SPA (`web/src/voice/livekit.ts` and `TowerDesk.tsx`).

## Reconnect / token refresh

- `RoomEvent.Disconnected` → `reconnectRoom()`:
  - Exponential backoff (`500ms · 2^n`, capped at 30 s, attempts capped
    only by `shuttingDown`).
  - Each attempt re-fetches a fresh token (LiveKit tokens have a TTL; old
    one will be expired after a long disconnect).
  - First successful reconnect resets the attempt counter.

This whole block is the fix for the bug where the bridge silently stayed
in `Disconnected` after the first server-side drop. Don't remove it.

## KSP watchdog

When `KSP_WATCHDOG=1` (which `start-bridge.cmd` sets by default):

- Every `KSP_WATCH_INTERVAL_MS` (default 5000), check if `KSP_x64.exe` is
  in the `tasklist` output.
- If absent for `KSP_WATCH_MISSES_BEFORE_EXIT` consecutive polls
  (default 3), the bridge cleanly shuts down.

Fail-open: if `tasklist` itself errors, the bridge keeps running.

This means: **closing KSP closes the bridge**, no orphan Node processes.
On non-Windows the watchdog is a no-op (returns true).

## Environment

| Variable | Default | Notes |
|---|---|---|
| `TOWER_API_BASE` | `http://127.0.0.1:48787/v1` | Backend `/v1` URL. `start-bridge.cmd` injects this from the plugin's settings. |
| `SESSION_ID` | `dev-shared` | Room name suffix; `tower-{SESSION_ID}` is the LiveKit room. |
| `BRIDGE_IDENTITY` | `ksp_bridge` | LiveKit identity. Must match an entry in backend's `LIVEKIT_BRIDGE_IDENTITIES`. |
| `DEV_VOICE_IDENTITY_HEADER` | `x-ksc-voice-identity` | Header name for dev identity injection on the token endpoint. |
| `PCM_HOST` / `PCM_PORT` | `127.0.0.1` / `47372` | Downlink listen socket. |
| `CTL_HOST` / `CTL_PORT` | `127.0.0.1` / `47373` | Control listen socket. |
| `KSP_WATCHDOG` | unset | `1`/`true`/`yes`/`on` enables watchdog. |
| `KSP_PROCESS_NAME` | `KSP_x64.exe` | Override for non-default builds. |
| `KSP_WATCH_INTERVAL_MS` | `5000` | Min 2000. |
| `KSP_WATCH_MISSES_BEFORE_EXIT` | `3` | Min 1. |

## start-bridge.cmd

Generated by `build-bridge-runtime.ps1`. Responsibilities:

- Resolve the bundled `node.exe` (next to the script).
- Source the runtime env file (`runtime.env` or similar) baked at package time.
- Set `KSP_WATCHDOG=1` if missing.
- `node app\dist\bridge.js`.

If you need to attach a debugger: edit the cmd file to pass
`--inspect=127.0.0.1:9229` to `node`.

## Dependency toolchain

Both the legacy outer package and the maintained inner package require Node 24+
and use LiveKit RTC 1.1.0, Node typings 26.6.5, tsx 4.23.15, and TypeScript 7.0.2.
Node typings do not change the supported runtime minimum. The outer `npm start`
uses Node from PATH through tsx rather than a machine-specific Node 18 path.

LiveKit 1.0 marks the SDK stable; 1.1 adds RPC interceptors. The bridge's audio,
room, and data APIs remain compatible. TypeScript 7 builds the existing NodeNext
configuration without source changes. The SDK now shares CJS implementation
files with an ESM wrapper, so the versioned patch targets `dist/room.cjs` and
`src/room.ts`. It retains duplicate-participant and data-handle disposal guards.

Run `npm ci`, `npm run postinstall`, `npm exec tsc -- --noEmit`, `npm test`, and
`npm run build` in the inner package before packaging. If npm blocks lifecycle
scripts, explicitly run `npm run postinstall` to apply the SDK patch.

## Building the runtime

From `KSCTowerNetwork-voice-bridge/voice-bridge/`:

```powershell
# Build TypeScript only:
npm run build

# Full runtime including portable node + start script + native deps:
.\scripts\build-bridge-runtime.ps1 -NodeExePath "C:\Program Files\nodejs\node.exe"
```

The runtime gets copied into
`GameData/KSCTowerNetwork/PluginData/bridge-runtime/`. End users get this
folder verbatim from the release ZIP.

See `RUNTIME_DISTRIBUTION.md` (in the bridge repo) for the ZIP layout and
distribution recipe.

## Common bridge issues

| Symptom | Likely cause |
|---|---|
| KSP logs `[KSCTowerNetwork] connect refused 127.0.0.1:47372` | Bridge not started; check `autoStartVoiceBridge` and `bridgeExecutable` paths. |
| Bridge logs `livekit-token HTTP 401` | Backend rejected; bridge identity not in `LIVEKIT_BRIDGE_IDENTITIES`, or LiveKit creds unset. |
| Bridge connects, then disconnects every ~10 minutes, no reconnect | Old build without the `RoomEvent.Disconnected` handler. Rebuild from source. |
| KSP exits but Node lingers | Watchdog disabled or `tasklist` permission denied. Set `KSP_WATCHDOG=1` and verify `KSP_PROCESS_NAME`. |
| Tower hears nothing from pilot | Tower tab needs to be the one publishing mic; verify `ksp_ptt` data-channel packet received in browser console. |
