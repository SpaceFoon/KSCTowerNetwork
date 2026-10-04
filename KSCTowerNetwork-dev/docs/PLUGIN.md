# KSP Plugin

C# DLL loaded by KSP at startup. Built from `KSCTowerNetwork-dev/PluginSrc/`.
Compiled into `GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.Client.dll` by
`build-plugin.ps1`.

> ⚠️ **KSP must be closed when running `build-plugin.ps1`.** Unity holds an
> open file handle on the loaded DLL.

## KSP mod dependencies

The plugin DLL detects every external mod by reflection — none of them are a
hard load-time dependency, so a player with only `KSCTowerNetwork` + the bridge
runtime gets a working tower client, just with fewer integrations. The CKAN
listing (`ckan/KSCTowerNetwork.netkan`) is the source of truth; `PROJECT_OVERVIEW.md`
§10 has the full per-mod table. Quick map of which source files care:

| Mod (CKAN id) | Tier | Source files that touch it | Behavior with mod absent |
|---|---|---|---|
| `ModuleManager` | Required for `Patches/` | `GameData/KSCTowerNetwork/Patches/*.cfg` (`MM_HookCommRadio`, `MM_AddTowerMicProp_DE_mk1Cockpit`) | Patches silently skipped; DLL loads, toolbar/HUD/voice all work, but the IVA PTT prop never spawns. |
| `RasterPropMonitor` | Recommended | `KSCTowerRpmMic.cs` (RPM `JSIActionGroupSwitch` IVA prop), RPM half of `KSCTowerCommRadioPtt.cs` + `TowerCommRadioFreqSync.cs` (`{Get,Set}PersistentVariable`) | No IVA PTT button, no IVA frequency dial sync. Toolbar `R`-key PTT still works. |
| `HullcamVDSContinued` | Recommended | `TowerHullCamRelay.cs` (HTTP poll of `127.0.0.1:8080`, JPEG POST to `/v1/hullcam/{sid}/{camId}`) | Tower Desk `HullCamPanel` stays empty; relay backs off silently with long retry. |
| `kOS` | Recommended | `TowerAcarsKosBridge.cs` (file mailbox in `Ships/Script/`, auto-installs `acars.ks` + `acars_lib.ks`); `TowerKosScreenAutoCapture.cs` (reflection on `kOS.Module.kOSProcessor` → `IScreenBufferLine.LastChangeTick` diff → `/v1/session/{sid}/kos-screen`) | ACARS-from-kerboscript inert; web `KosScreenPanel` never fills. Plain web ACARS unaffected. |
| `AvionicsSystems` (MAS) | Recommended (RPM alternate) | MAS half of `KSCTowerCommRadioPtt.cs` + `TowerCommRadioFreqSync.cs` (`{Get,Set}Persistent`) | If your IVA is MAS-only, that pod loses in-cockpit PTT + freq sync. Other pods unaffected. |
| `Chatterer` | Optional — not recommended | `TowerChattererDuck.cs` (PTT ducking; optional full-flight mute via `blockChattererInFlight` in `settings.cfg`) | Not required. If absent, tower voice works the same. If present, ducking avoids bleed-through; live ATC is usually clearer with Chatterer off — see `INTEGRATIONS.md`. |
| `ASET-Props` | Cosmetic asset pack | Ships the visual model for `pb_KSCTOWER_mic_PTT` and the ASET COMM Radio prop whose persistents the comm-radio hooks watch. | IVA PTT button shows as a missing prop in any cockpit that places it. |
| `ASET-Avionics` | Cosmetic asset pack | Avionics-prop dependency of the ASET COMM Radio prop (lights, dial textures). | Broken visuals on the ASET radio prop. |
| `DE-IVAExtension` | Cosmetic / cockpit-specific | `MM_AddTowerMicProp_DE_mk1Cockpit.cfg` is gated `:NEEDS[RasterPropMonitor&DE_IVAExtension]`. | DE mk1 cockpit doesn't get the IVA PTT button. |

Hard rule when adding a new mod integration: keep the dependency optional. Use
`Type.GetType` / `Assembly.GetTypes` to look the API up at runtime, cache the
`MethodInfo`, and bail out cleanly if it's missing. **Do not** add a hard
project reference to a third-party mod's DLL — the build-plugin script doesn't
ship those, and players who don't run that mod would crash on load.

## What gets loaded

When KSP starts and the player loads a save, KSP scans `GameData/`. The
plugin's runtime tree is:

```
GameData/KSCTowerNetwork/
├── Plugins/
│   ├── KSCTowerNetwork.Client.dll ← compiled output of PluginSrc/
│   └── KSCTowerNetwork.version    ← JSON: mod VERSION + KSP range; CKAN + AVC (see ../ckan/README.md)
├── Patches/
│   └── *.cfg                      ← ModuleManager patches (RPM mic prop, etc.)
├── Props/                         ← IVA props (RPM PTT switch)
├── PluginData/
│   ├── settings.cfg               ← user-edited config (gitignore'd)
│   ├── settings.example.cfg       ← shipped template
│   ├── auth.cfg                   ← persisted plugin_session JWT (chmod 600 in spirit)
│   └── bridge-runtime/            ← bundled portable Node + bridge.js
│       ├── start-bridge.cmd
│       ├── node/
│       └── app/
├── Scripts/
│   ├── acars.ks                   ← installed into kOS Archive on first run
│   └── acars_lib.ks
└── Localization/
```

Nothing else may live at the mod root — `build-plugin.ps1` enforces that.

## Source files

| File | Role |
|---|---|
| `TowerModSettings.cs` | Loads `settings.cfg`/`auth.cfg`. Owns shared static config. Spawns and tracks the voice bridge subprocess. |
| `TowerLoginGui.cs` | In-game IMGUI window for the email/password login flow + exchange-code redemption. |
| `TowerSecureStore.cs` | DPAPI-style per-user encrypted blob for storing the `plugin_session` JWT. |
| `TowerApiAuth.cs` | Tiny helper: builds the `Authorization: Bearer …` header from the cached JWT. |
| `TowerToolbar.cs` | Stock-toolbar buttons (radio, ACARS) + clamping/positioning. |
| `TowerRadioGui.cs` | Main radio panel: power, freq tune, VU meters, PTT, utility row. Quick-tune ◀/▶ presets match `backend/src/config/radioPresets.ts`. **MHz LCD** is procedural segment rendering (no runtime font); **COM** snaps to **25 kHz**; **VOL** adjusts helmet listen gain (persisted in `auth.cfg`). See [`TOWER_RADIO_UI.md`](TOWER_RADIO_UI.md). **Live internet radio / stream stations are not shipped** — see [`RADIO_LIVE_STREAMS.md`](RADIO_LIVE_STREAMS.md). |
| `TowerAcarsGui.cs` | ACARS message panel (incoming + outgoing, chat-like). Three channel tabs: **Session** (per-room ops chat, `/v1/session/{id}/messages`), **Lobby** (global text chat shared with the web portal's lobby, `/v1/lobby/messages`), and **DM** (1:1 with another logged-in user, `/v1/dm/{peer}/messages`). |
| `TowerAcarsToolbar.cs` | Toolbar entry just for ACARS. |
| `TowerAcarsKosBridge.cs` | File-based mailbox so kOS scripts can read/write ACARS via the kOS Archive volume. |
| `TowerKosScreenAutoCapture.cs` | Reflection-based auto-capture: walks every active `kOS.Module.kOSProcessor`, diffs each `IScreenBufferLine` by `LastChangeTick`, and POSTs changed lines to `/v1/session/:id/kos-screen` so kOS terminal output mirrors to the web with no script-side opt-in. |
| `TowerTelemetryPublisher.cs` | Posts vessel state to the backend. Handles the adaptive next-interval response. |
| `TowerHullCamRelay.cs` | Polls JRTI HullCam JPEGs and POSTs them to the backend. |
| `TowerWorldInventory.cs` | Walks the active save to publish vessel/runway/airfield catalog. |
| `TowerBasemapBaker.cs` | Generates a static map tile from KSP's planet textures + heightmaps so the web tower has a real basemap. |
| `TowerVoicePlayback.cs` | Connects to `127.0.0.1:47372`, drains s16le PCM into a Unity `AudioSource`. Output level follows `TowerModSettings.VoiceListenVolume` (`RefreshListenVolumeFromSettings`). |
| `TowerVoiceListenUiLogic.cs` | Pure rules for helmet **ON AIR** and **BRIDGE** annunciators (no Unity); shared with `plugin-tests/` so behavior is unit-tested without loading KSP. |
| `TowerCommRadioIvaPure.cs` | Pure RMS smoothing, write coalescing rules, and persistent→bool parsing for IVA COMM radio; shared with `plugin-tests/` (no Unity). |
| `TowerVoiceAutoConnect.cs` | Triggers playback connect after a configurable delay. |
| `TowerVoiceBridgeControl.cs` | Background-thread queue for sending control lines to `127.0.0.1:47373`. |
| `TowerVoiceBridgeLauncher.cs` | Spawns `start-bridge.cmd` if `autoStartVoiceBridge=True`. |
| `TowerVoiceBridgeMenuQuit.cs` | Sends a clean shutdown signal on KSP main-menu quit. |
| `TowerVoiceBridgeRespawnQueue.cs` | Re-spawn the bridge if the watchdog stopped it but KSP is still running. |
| `TowerMicMeter.cs` | VU meter feed for the radio GUI. |
| `KSCTowerRpmMic.cs` | RasterPropMonitor IVA PTT switch — translates an IVA prop press into `MIC_ON`/`MIC_OFF`. |
| `TowerCountdownState.cs` | Static state for backend-driven countdowns (T-minus). |
| `TowerCountdownHud.cs` | On-screen HUD for the active countdown. |
| `TowerMainThreadDispatcher.cs` | `Run(Action)` to bounce work back to the Unity main thread from background threads. |

## Voice listen UI (ON AIR, BRIDGE, AUDIO)

The radio panel’s **power** switch label (“ON AIR (LISTENING)”) is driven by
`TowerVoicePlayback.IsListenUiOnAir`, which delegates to
`TowerVoiceListenUiLogic.IsListenUiOnAir` with live ticks from the TCP worker.
Roughly:

- **OFF** if the listen worker is not running or `StopBridgeConnection` has
  cleared the session.
- **ON** during the first **12 seconds** after `StartBridgeConnection` while
  the `TOWER_PCM` header is still negotiating, or once the header is set if
  the last TCP payload was fewer than **10 seconds** ago (stale socket / long
  silence reads as OFF even if the worker thread is still alive in a
  reconnect loop).

The **BRIDGE** lamp still means “voice-bridge control port looks alive”, but it
dims when the player has asked for helmet audio (`WantsHelmetVoiceListen`) and
the TCP thread is up yet the listen path is in that stalled state — see
`TowerVoiceListenUiLogic.BridgeLedLit` and `TowerRadioGui.DrawLedRow`.

**AUDIO** reflects `HasStreamHeader`. Each new TCP attempt clears the header at
the start of `RunTcpClientOnce` so the lamp does not stay latched across a
dead connection during backoff.

Failed `POST /v1/session/claim-pilot` (and `SetActiveChannel` failure in
`AdoptRoomId`) calls `StopBridgeConnection` so the annunciators are not left
green while the status line says the tune failed.

## Automated tests (listen UI logic)

There is still **no** Unity test harness for the full plugin. Pure rules in
`TowerVoiceListenUiLogic.cs` are covered by a tiny **.NET Framework `csc`**
runner that does not reference KSP assemblies:

| Path | Role |
|------|------|
| `plugin-tests/TowerVoiceListenUiLogicTests.cs` | Assertions on `IsListenUiOnAir` and `BridgeLedLit` with fixed UTC clocks. |
| `plugin-tests/run-listen-ui-tests.ps1` | Compiles `TowerVoiceListenUiLogic.dll` + test exe into `plugin-tests/obj/`, runs tests, exits non-zero on failure. |

From `KSCTowerNetwork-dev/`:

```bash
npm run test:plugin-listen-ui
```

Or:

```powershell
.\plugin-tests\run-listen-ui-tests.ps1
```

`build-plugin.ps1` lists `TowerVoiceListenUiLogic.cs` with the rest of
`PluginSrc/`; changing thresholds or grace behavior should update both the
production code and the expectations in `TowerVoiceListenUiLogicTests.cs`.

## Automated tests (IVA COMM radio pure logic)

`TowerCommRadioRxSyncMath` and `TowerCommRadioPersistentValueParsing` in
`TowerCommRadioIvaPure.cs` are covered the same way (no KSP assemblies). This
does **not** replace an in-game IVA test pass; it locks the numeric and parsing
contracts used by `TowerCommRadioRxSync` and `KSCTowerCommRadioPtt`.

| Path | Role |
|------|------|
| `plugin-tests/TowerCommRadioIvaPureTests.cs` | Assertions on smoothing, carrier threshold, level clamp, `ShouldWrite`, and `AsBool` edge cases. |
| `plugin-tests/run-comm-radio-pure-tests.ps1` | Compiles `TowerCommRadioIvaPure.dll` + test exe into `plugin-tests/obj/`, runs tests, exits non-zero on failure. |

From `KSCTowerNetwork-dev/`:

```bash
npm run test:plugin-comm-radio-pure
```

## Hard rules for plugin code

1. **Never call synchronous TCP from the Unity main thread.** Use
   `TowerVoiceBridgeControl.EnqueueSend(host, port, line, callback)`. KSP
   freezing for 1-3 seconds because a TCP socket is blocking is a real
   shipped regression — see `AUDIT.md`.
2. **All `Debug.Log`/`ScreenMessages` must run on the main thread.** From a
   background thread, use `TowerMainThreadDispatcher.Run(() => Debug.Log(…))`.
3. **Don't do blocking HTTP in `Update()`.** Use `UnityWebRequest` with
   `SendWebRequest()` + a coroutine. Telemetry publisher is already structured
   this way; copy that pattern.
4. **Persist secrets via `TowerSecureStore`, not plain text.** The
   `plugin_session` JWT lives in `auth.cfg` encrypted; never write it to
   `settings.cfg`.
5. **Don't add files outside the allowed mod-root subfolders** (`Plugins/`,
   `Patches/`, `Props/`, `PluginData/`, `Localization/`, `Scripts/`).
   `build-plugin.ps1` will fail the build.

## How `TowerModSettings` works

- Singleton `KSPAddon`. `Awake` reads `settings.cfg`, falling back to
  defaults from `settings.example.cfg`'s shape.
- Properties expose every setting (`TowerApiBaseUrl` is constructed from
  `towerApiHost`/`Port`/`Path`/`Tls`).
- The `IsBridgeAutoStart` getter and `StartBridgeIfConfigured()` method are
  what `TowerVoiceBridgeLauncher` uses on startup.
- `OnDestroy` (KSP shutdown) sends a SIGTERM-equivalent to the bridge
  subprocess and waits up to ~1 s before continuing.

## Login flow (in-game)

`TowerLoginGui` walks the user through:

1. Open a browser to the configured backend's web URL.
2. Log in to the web UI as the role-bearing account.
3. Click "Pair plugin" → web mints a one-time exchange code (8+ chars).
4. Type that code into the in-game GUI.
5. Plugin POSTs `/v1/auth/plugin/exchange { code }` → backend returns a
   long-lived `plugin_session` JWT.
6. Plugin stores it via `TowerSecureStore`.

Subsequent KSP launches reuse the stored JWT — no login UI on second run.
`/v1/auth/me` is called on connect to sanity-check the token; if 401, the
plugin clears the cache and reopens the login GUI.

## Telemetry publisher

`TowerTelemetryPublisher` is the high-frequency path. Per tick:

1. Build a JSON payload from `FlightGlobals.ActiveVessel` (lat/lon, AGL, ASL,
   surface speed, vertical speed, attitude, biome, gear/lights/RCS/SAS
   flags, mass, crew, optional vessel target, subsystems snapshot, etc.).
   The publisher also attaches **lightweight, plugin-side** fields so the tower
   does not re-derive KSP math: **`sampleUnixMs`** (UTC epoch ms); **smoothed**
   `smoothedLat` / `smoothedLon` / `smoothedAslAlt` with **`smoothedPositionValid`**
   (raw `lat`/`lon`/`aslAlt` remain authoritative for backend scoring); **ENU**
   surface velocity `srfVelNorth` / `srfVelEast` / `srfVelUp`; on **Kerbin** only,
   KSC-sector hints aligned with the web aero charts (`distKSC`, `bearingKSC`,
   `alignErr`, `activeRunway`, `kscAerodrome`, `onApproach`, `landing`,
   `flightPhase`, `touchdownEtaSec`); **`radioFreqMhz`** / **`radioPtt`** from the
   tuned channel + `TowerPttBus`; and **`fuelLow`** from main propellant totals.
   While **`onApproach`**, it may post debounced **`[CALL] … km from KSC`** lines
   to **`POST /v1/session/{sessionId}/messages`** (same bearer as ACARS; can fail
   if session chat is blocked — callouts are optional).
2. Send that JSON over **UDP** (`TowerUdpClient`, when `useUdpLiveTransport=True`
   and the path works) or **`POST /v1/telemetry/{sessionId}`** when falling back
   or when UDP is disabled (`liveUdpFallbackHttp`, etc.).
3. Backend response includes `nextTelemetrySeconds` and (optionally)
   `assignedSquawk`/`assignedCallsign`/`countdown`, plus tower echo fields
   when present: `clearances`, `recentViolations`, `phaseTimeline`,
   `approachSequence`, `lastLandingQuality` (same shape as HTTP and UDP;
   `TowerTelemetryPublisher.ParseClearances` feeds `TowerClearanceState` for
   the in-cockpit HUD).
4. Re-arm the timer with the returned interval.

This is what makes the controller's map "live" without overwhelming a slow
link — the backend can dial it from 5 s default down to 1 s when the craft
is on short final. **`TowerGhostFleet`** reads other pilots from
`/v1/tower/active-aircraft` and uses **smoothed** lat/lon/ASL when the snapshot
includes `smoothedPositionValid` so local render matches the tower map.

**Server session lifetime:** Each successful telemetry POST updates
`lastTelemetryAt`. If samples stop for longer than the tower host's
`PILOT_IDLE_CLOSE_SECONDS` (default 120), the backend may **soft-close** the
tower session (same as the web lobby **Close**), which drops the room from
`/v1/lobby/rooms` and clears everyone's active-room binding. Operators tune this
via [SETTINGS_REFERENCE.md → Telemetry](SETTINGS_REFERENCE.md#telemetry); pilot
symptoms are covered in [TROUBLESHOOTING.md → Lobby and tower sessions](TROUBLESHOOTING.md#lobby-and-tower-sessions).

## HullCam relay

`TowerHullCamRelay` discovers cameras and pulls JPEG snapshots from **Just
Read The Instructions**' local HTTP API (defaults to `http://127.0.0.1:8080`;
see `HullCamJrtiBaseUrl` in [SETTINGS_REFERENCE.md](SETTINGS_REFERENCE.md)).
It does **not** watch a folder on disk — every frame is `GET` from JRTI, then
`POST` to the tower backend.

For each frame:

1. `GET` snapshot bytes from JRTI (`/camera/{id}/snapshot`).
2. `POST` to `/v1/hullcam/{sessionId}/{cameraId}` on `ApiBaseUrl` (raw body,
   `Content-Type: image/jpeg`).
3. Drop frames that arrive faster than the configured upload cadence so we
   don't saturate uplink, and drop frames larger than `HullCamMaxBytes` so we
   never round-trip a payload the backend will 413 anyway.

**Why HTTP?** JRTI only speaks plain HTTP on loopback — there is no TLS or
WebSocket option there. That hop never leaves the pilot's machine. The hop
from KSP to your tower API uses whatever scheme is in `ApiBaseUrl` (often
`http://` in dev, `https://` in production).

The backend keeps **only the latest** frame per camera; the controller's
`HullCamPanel` uses bearer-authenticated `fetch` (not a bare `<img src>`) to
`GET` `/v1/hullcam/{sessionId}/{cameraId}/snapshot.jpg` on a ~1 Hz timer — see
comments in `web/src/components/HullCamPanel.tsx`. Frames are not pushed over
the live WebSocket today; the snapshot path is simple JPEG-in, JPEG/WebP-out.

The snapshot handler re-encodes the JPEG (downscale + mozjpeg, optionally WebP
via `Accept` negotiation) on the fly the first time a viewer asks for it — see
[BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline) for sizing,
limits, lazy-encode cache, and **server CPU / bandwidth / RAM** expectations.

## kOS bridge

`TowerAcarsKosBridge` writes JSON files into the kOS Archive
(`Ships/Script/` by default) so a KerboScript program can read tower
messages and queue replies. Two scripts (`acars.ks` and `acars_lib.ks`) are
auto-installed once on first run if `kosBridgeAutoInstallScript=True`. Run
`RUN ACARS.` from a kOS terminal to start the interactive monitor.

To fully suppress kOS reads/writes: `kosBridgeEnabled = False`.

## kOS screen mirror

`TowerKosScreenAutoCapture` mirrors **all** kOS terminal output to the web
Tower desk's `KosScreenPanel` with zero script-side opt-in — install kOS,
the panel starts filling. It is **one-way only** (kOS -> web). Chat / ACARS
continue to flow through `TowerAcarsKosBridge` so screen spam never
pollutes the controller's clearance feed.

Flow:

1. The component is `[KSPAddon(Flight, false)]` and starts a single capture
   coroutine on flight scene entry.
2. On the first tick after flight loads, it locates `kOS.Module.kOSProcessor`
   reflectively across all loaded assemblies (no compile-time dependency on
   `kOS.dll` — the rest of the plugin loads cleanly when the player has no
   kOS install). On API drift it logs once and disables itself for the
   session.
3. Every ~500 ms, while the player is signed in (or `skipTowerLogin`) and
   the cockpit **KOS** toggle is on, it `FindObjectsOfType`s every active
   `kOSProcessor` part and walks each one's `shared.Screen.GetBuffer()`.
4. For each row in the buffer it compares `IScreenBufferLine.LastChangeTick`
   against the previously-cached value. Changed rows have their text
   extracted via `ToArray()`, right-trimmed (kOS pads to `ColumnCount` with
   spaces), and shipped to `POST /v1/session/{sessionId}/kos-screen` with
   the same bearer token the ACARS bridge uses.
5. The web `KosScreenPanel` polls
   `GET /v1/session/{sessionId}/kos-screen?since=<iso>` every ~2 s and
   appends new lines into a CRT-styled monospace block.

**Scroll dedupe.** kOS rewrites the entire visible buffer when a single
PRINT scrolls the screen, which would naively re-ship every visible row.
To collapse those, each processor keeps a 3-second TTL ring of
recently-shipped lines; any line seen again within that window is silently
swallowed. A genuine "PRINT same status string every 5 seconds" still goes
through.

**First-tick seeding.** When the capture sees a brand-new `kOSProcessor`
for the first time it seeds the per-row `LastChangeTick` cache from the
current buffer state without shipping anything, so the kOS welcome banner
/ pre-existing buffer doesn't flood the web on scene entry.

**Safety valves.** Per-tick cap is `MaxLinesPerProcessorPerTick = 8` (a
wide reflow / `CLEARSCREEN` won't fire 36 POSTs back-to-back), and the
per-line hard truncate is `MaxLineLength = 1000` chars. Both are
const-only — the whole point of this rewrite is "no settings to read, it
just works".

**Player-facing toggle.** The cockpit radio panel has a **KOS** switch
next to **BCN** and **CAM**. Clicking it flips
`TowerModSettings.KosScreenStreamActive` and persists to `auth.cfg`, so
the choice survives scene changes and game restarts. There is no separate
`settings.cfg` knob in the typical install (legacy `kosScreenEnabled` is
still read as a fallback for older configs).

### Future work: interactive remote terminal (Phase 2)

The auto-capture only mirrors output. A follow-up could add a keystroke
uplink so the web panel drives kOS too — likely either via reflection on
`SafeSharedObjects.Cpu`'s input queue, or by proxying through kOS's
built-in `127.0.0.1:5410` telnet server. The uplink would be hard-gated
to controller-role sessions only.

## Building

From `KSCTowerNetwork-dev/`:

```powershell
.\build-plugin.ps1
```

The script:

1. Verifies KSP isn't running (warns if it is).
2. Verifies `GameData/KSCTowerNetwork/` only contains allowed subfolders.
3. Invokes `csc.exe` (or `dotnet build`) against the KSP managed assemblies
   in `<KSP>/KSP_x64_Data/Managed/`.
4. Drops the resulting `KSCTowerNetwork.Client.dll` into `Plugins/`.
5. Copies any updated patches/scripts.

If you see `MetadataException` on launch, the DLL was built against a
different KSP version's `Assembly-CSharp.dll`. Rebuild with the correct
managed-assemblies path.
