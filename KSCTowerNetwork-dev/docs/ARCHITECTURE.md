# Architecture

Four processes, three production networks (HTTP, WebRTC, loopback TCP), one
shared session id. Optional UDP is reserved for local development.

```
                                   Internet
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        │                              │                              │
        ▼                              ▼                              ▼
┌──────────────┐              ┌──────────────┐              ┌────────────────┐
│  Web SPA     │  HTTPS /v1   │  Backend     │              │  LiveKit Cloud │
│  (browser)   │◄────────────►│  Express+TS  │              │  (SFU + WS)    │
│  React + LK  │              │  Node 24 LTS │              └───────▲────────┘
│  Tower /     │              │              │                      │
│  Pilot UI    │ wss://…      │  MariaDB +   │                      │ wss
│              │◄───── voice ─┼──Redis  (or  │                      │ media
│              │              │  in-memory)  │                      │
└──────▲───────┘              └─────▲──────┬─┘                      │
       │                            │      │                        │
       │ WebRTC                     │ HTTP │ mints LiveKit          │
       │ (LiveKit JS)               │      │ JWTs                   │
       │                            │      ▼                        │
       │                            │   token                       │
       │                  ┌─────────┴───────────┐                   │
       │                  │ KSP machine         │                   │
       │                  │ (player's PC)       │                   │
       │                  │                     │                   │
       │                  │ ┌─────────────────┐ │ HTTPS /v1         │
       │                  │ │  KSP Plugin     │─┼───────────────────┘
       │                  │ │  (C#, Unity)    │ │
       │                  │ │                 │ │
       │                  │ │  loopback TCP:  │ │
       │                  │ │   :47372 PCM in │ │
       │                  │ │   :47373 ctl out│ │
       │                  │ └────┬─────▲──────┘ │
       │                  │      │     │        │
       │                  │      ▼     │        │
       │                  │ ┌─────────────────┐ │
       │                  │ │ Voice Bridge    │ │ wss
       │                  │ │ (Node child     │─┼───────────────────┐
       │                  │ │  process)       │ │                   │
       │                  │ │                 │ │                   │
       │                  │ └─────────────────┘ │                   │
       │                  └─────────────────────┘                   │
       │                                                            │
       └────────────────── voice peer in same room ─────────────────┘
              (ops mix: tower-{sessionId}; spectator booth: tower-{sessionId}-booth)
```

## Ports, firewall, and live transport

Default ports (change via server env / `settings.cfg`):

| Port | Direction | Process | Purpose |
|---:|---|---|---|
| **48787** | Clients → host | Backend Express | **`PORT`** — all `/v1/*` HTTP JSON + HullCam POST/GET + auth. |
| **45173** | Dev only | Vite | Web dev server; proxies `/v1` to backend (see `web/vite.config.ts`). |
| **47372** | Bridge → KSP | Voice bridge → plugin | PCM downlink (s16le mono). **Loopback only** in normal installs. |
| **47373** | KSP → bridge | Plugin → voice bridge | Control lines (`MIC_ON` / `MIC_OFF` / `PING`). **Loopback only**. |
| **48788** | Local development only | Plugin → backend | **`LIVE_UDP_PORT`** / `liveUdpPort` — optional empty-token UDP frames for local `DEV_OPEN_AUTH` development. Disabled by default and bound to loopback. |

**Firewall checklist (self-hosted):**

- **TCP** inbound: HTTPS (or HTTP) on the API port your pilots use (`towerApiPort` / `PORT`).
- **UDP** inbound: no public rule is needed. Authenticated plugin traffic uses
  HTTPS; the optional development UDP listener is disabled by default and
  binds to loopback.
- **Outbound** from backend: MariaDB, Redis, LiveKit control APIs — follow your provider docs.
- **LiveKit / WebRTC**: browsers and the voice bridge need outbound **UDP and TCP** to your LiveKit region (not the Express port).

**Authenticated plugin traffic:** live telemetry and roster queries use HTTPS
through **`POST /v1/telemetry`** and **`GET /v1/tower/active-aircraft`**. The
optional UDP path is for local development only; it accepts empty tokens and
is not a production transport. See
[PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md).

**Live WebSocket:** HTTP server upgrades **`LIVE_WS_PATH`** (default
`/v1/live/ws`) for browser push snapshots; same origin and TLS termination as
the API. Disable with **`LIVE_WS_ENABLED=false`** if needed.

**Session snapshots:** In-process code calls `publishLiveSnapshotEvent({ topic: "session", sessionId })` (`backend/src/live/liveSnapshotBus.ts`). `wsTransport.ts` invalidates the short-TTL session snapshot in `snapshotCache.ts` and pushes `{ type: "snapshot", topic: "session.detail", sessionId, data }` to every connected client that is subscribed to that `sessionId`. The web hook **`useTowerLiveSubscriptions`** (`web/src/live/useTowerLiveSubscriptions.ts`) writes `data` into TanStack **`queryKeys.session.detail`**, so **TowerDesk** / **TowerWall** can turn off slow HTTP `refetchInterval` while the socket is healthy. Anything that mutates tower-visible session fields without going through telemetry (ephemeral **takeoff** / **countdown request** markers, dismiss/grant, booth mute, etc.) must publish **`session`** or operators only see the change on the next telemetry POST, the WS **5 s** safety refresh, or a manual invalidate.

### Launch countdown, takeoff pings, and controller resolve

Structured state lives on the in-memory **`SessionRecord`** (`countdownRequest`, `takeoffRequest`); it is **not** loaded from MariaDB in `mapSessionRow` (same class of ephemera as booth mute and shared waypoints).

1. **Pilot → backend:** `POST /v1/session/{id}/countdown/request` with `{"kind":"launch"}` sets `countdownRequest` and a `[REQUEST] …` chat line; `{"kind":"takeoff"}` (plugin uses this for planes/rovers) sets `takeoffRequest`, clears the launch marker, and posts `[ALERT] … takeoff clearance`. Rate-limited per (session, user). `GET /v1/session/{id}` runs `pruneStaleTakeoffRequest` so takeoff pings older than **10 minutes** drop off on read.
2. **Synced rocket count:** `POST …/countdown/start` (controller) persists `countdown_starts_at` / `countdown_length_sec` when DB mode is on, and clears both pending markers in memory. `POST …/countdown/scrub` clears the clock. Telemetry replies echo **`countdown`** for the in-game rocket HUD and **`takeoffClearanceAtMs`** (epoch ms) for **10 s** after tower grants takeoff (`pilot-pending` grant or clearance strip **TAKEOFF** cleared); the plugin radio row parses this with **`TowerTakeoffClearanceState`**. Structured **`takeoffRequest`** / **`countdownRequest`** stay on **GET** / live **session.detail** for the web tower.
3. **Controller resolve:** `POST …/pilot-pending/handle` with **`controller:assume`**, body `{ target: "takeoff" | "launch", action: "grant" | "dismiss" }`. **Takeoff:** `grant` clears the marker and posts `[CLEARANCE] Cleared for takeoff`; `dismiss` clears without that line. **Launch:** only `dismiss` is valid for this route (removes `countdownRequest` without starting); approving a launch request remains **`POST …/countdown/start`**. Response `{ ok, changed }` is idempotent when nothing was pending.
4. **Clearance strip:** `POST …/clearance` with `TAKEOFF` + `cleared` also clears structured `takeoffRequest` via `setSessionClearance` in `repository.ts` (in addition to persisting `clearances_json` when DB-backed).

Tower UI: **`web/src/session/CountdownPanel.tsx`** surfaces **Start / Scrub**, **Dismiss launch request**, and takeoff **Cleared for takeoff / Dismiss** for controllers.

---

## Data flows

### Audio: pilot ⇄ tower

1. **Tower → pilot**:
   - Browser publishes mic via LiveKit JS (optional **Kerbalizer** DSP on the
     send path; **Krisp** noise filter is off while Kerbalizer is on).
   - LiveKit SFU forwards the audio track to all participants in the **ops**
     room `tower-{sessionId}`, including the bridge. Spectator **booth** voice
     is a separate room `tower-{sessionId}-booth` (web-only; not mixed to KSP).
   - The web ops UI (`VoiceDesk`) and booth UI (`BoothDesk`) each call
     `connectVoiceRoom` in `web/src/voice/livekit.ts`; both can show an
     **incoming** level bar driven by remote track analysers + participant
     `audioLevel` (time-domain RMS is mixed in so the meter tracks speech when
     frequency-domain reads near zero).
   - The bridge subscribes (`RoomEvent.TrackSubscribed`), feeds remote
     tracks into `AudioMixer`, and pumps mixed s16le 48 kHz mono frames over
     the loopback PCM TCP socket (`127.0.0.1:47372`).
   - The plugin's `TowerVoicePlayback` reads from the socket on a background
     thread and feeds samples to a Unity `AudioSource` in the cockpit.

2. **Pilot → tower**:
   - Plugin reads PTT (key, RasterPropMonitor IVA switch, or kOS request).
   - On the Unity main thread it calls `TowerVoiceBridgeControl.EnqueueSend`
     with `MIC_ON` / `MIC_OFF`. Send happens on a background thread to avoid
     stalling the simulation.
   - Bridge receives the line on `127.0.0.1:47373`, calls
     `room.localParticipant.publishData({ type: "ksp_ptt", on, from })` on
     the **reliable** LiveKit data channel.
   - Tower web tab listens for `ksp_ptt` packets and toggles **its own**
     `LocalParticipant` mic. The pilot's KSP **never sends WebRTC media**.
   - This avoids loading native PortAudio bindings into the same process as
     `@livekit/rtc-node`, which used to crash the bridge the instant `MIC_ON`
     ran. (`bridge.ts` lines 7-11 explain it.)

### Telemetry: pilot → backend → tower

1. `TowerTelemetryPublisher` sends vessel state (lat/lon, alt, speed,
   attitude, flags, biome, etc.) on an adaptive timer. When
   the normal authenticated path is **`POST /v1/telemetry/{sessionId}`** over
   HTTPS. Optional local-development UDP requires `useUdpLiveTransport=True`,
   an empty token, `DEV_OPEN_AUTH=1`, and a loopback listener. The same JSON
   schema applies on both paths.
   The plugin also emits **additive** fields for tower UX: **`sampleUnixMs`**;
   **smoothed** lat/lon/ASL plus **`smoothedPositionValid`** (raw `lat`/`lon`/`aslAlt`
   stay the scoring truth); **ENU surface velocity** (`srfVelNorth` / `srfVelEast` /
   `srfVelUp`); on **Kerbin** only, KSC-sector context (`distKSC`, `bearingKSC`,
   `alignErr`, `activeRunway`, `kscAerodrome`, `onApproach`, `landing`,
   `flightPhase`, `touchdownEtaSec`); **`radioFreqMhz`** / **`radioPtt`** (COM
   tune + PTT bus snapshot, not voice media); and **`fuelLow`**. In-game
   **`TowerGhostFleet`** prefers smoothed positions when valid so other pilots’
   proxies move more smoothly. While **`onApproach`**, the publisher may post
   debounced **`[CALL] … km from KSC`** lines to **`POST /v1/session/:id/messages`**
   (best-effort; depends on auth/CSRF like any session chat write).
2. Backend validates (Zod / UDP decoder), stores in repository, updates live
   snapshot caches for Web subscribers.
3. `TowerDesk` map renders markers; flight strips show altitude/speed/heading.
   The embedded **`TowerWall`** monitor (`web/src/components/TowerWall.tsx`) can
   show **per-pilot** status + telemetry cards: lobby roster
   (`GET /v1/lobby/rooms`) plus one `GET /v1/session/:id` poll per visible card
   (tracked session at 1 s, others at 3 s when live WebSocket push is off).
4. The plugin paces uploads from **`nextTelemetrySeconds`** (and related
   fields) returned either in the **HTTP POST** JSON body or in the **UDP
   reply** payload after a successful datagram — see `ParseNextInterval` in
   `TowerTelemetryPublisher.cs` and `backend/src/live/protocol.ts`.
5. After each accepted sample, the backend runs **`runTowerTelemetryHooks`**
   (`backend/src/tower/afterTelemetry.ts`): phase timeline, approach sequence
   ranking, separation conflict detection (RP violation messages), runway
   occupancy heuristics, missed-approach / touchdown landing-tier messages, and
   optional violation events. The same telemetry **reply** JSON (HTTP + UDP)
   echoes **`clearances`**, **`recentViolations`**, **`phaseTimeline`**,
   **`approachSequence`**, and **`lastLandingQuality`** for cockpit UI — see
   `buildTelemetryReplyPayload` in `backend/src/tower/telemetryReplyPayload.ts`.

See [PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md) for cadence
tables and profiling notes.

### HullCam: pilot → backend → tower

1. JRTI HullCam KSP mod exposes JPEG snapshots over a local HTTP listener.
2. `TowerHullCamRelay` polls for new frames at 1 Hz (configurable, capped at
   2 Hz in the plugin and 5 fps server-side) and uploads to
   `POST /v1/hullcam/{sessionId}/{cameraId}` with `Content-Type: image/jpeg`.
   Body capped server-side at 192 KB (express.raw) and rejected unless the
   first two bytes are the JPEG SOI marker.
3. Backend keeps only the latest frame per camera in `hullcamStore` (in-memory,
   per-camera, with a 10 s stale TTL and `MAX_SESSIONS=128` /
   `MAX_CAMERAS_PER_SESSION=8` caps).
4. `HullCamPanel` in the web UI fetches the snapshot endpoint at a polling
   interval. The first viewer for a fresh frame triggers a one-shot sharp
   re-encode (downscale to ≤960 px wide, mozjpeg q78, plus a parallel WebP
   variant negotiated via `Accept`); concurrent viewers dedupe to a single
   encode. Stale (>10 s) frames return `503 {reason: "los"}` so the UI can
   distinguish "lost feed" from "no such session".

See [BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline) for the
full set of limits, sizes, and tunables.

### ACARS / chat

- **Lobby chat**: anyone with `chat:lobby`. Stored as `appendLobbyMessage`.
- **Session chat**: only session participants + admins
  (`isSessionParticipantOrAdmin`). Surfaced in `ChatDesk`/`TowerDesk`.
- **DM**: 1:1, both sides need `chat:dm`. Threads via `listDirectMessageThreads`.
- **kOS bridge**: file-based mailbox in the kOS Archive (`Ships/Script/`) so
  KerboScript can read incoming messages and queue outgoing ones.

### Auth: token mint + verify

- Plugin gets a permanent `plugin_session` JWT via the **exchange code**
  flow: web user mints a 1-time code, types it into the in-game login GUI,
  plugin POSTs `/v1/auth/plugin/exchange`.
- Web users get a `tower_web` JWT from `POST /v1/auth/login` (or Clerk
  session token).
- Browser-only "spectator" sessions get a `guest` JWT from
  `POST /v1/auth/guest`, IP-bannable with finer-grained limits.
- The voice bridge **does not use JWTs**. It uses
  `x-ksc-voice-identity: ksp_bridge` against a dev-only header (in dev) or a
  short-lived LiveKit room token minted by the backend (`POST /v1/session/:id/livekit-token`).

## Process lifecycles

| Process | Started by | Killed by |
|---|---|---|
| Backend | `npm run dev:backend`, systemd, Railway, etc. | `SIGINT`/`SIGTERM`. Long-lived. |
| Web SPA | Browser navigates to it. | Tab close. |
| KSP plugin | KSP loads `Plugins/KSCTowerNetwork.dll` on game start. | KSP exit. |
| Voice bridge | `TowerVoiceBridgeLauncher.cs` spawns `start-bridge.cmd` when KSP starts (if `autoStartVoiceBridge=True`). Manually via `npm run dev:bridge`. | KSP `OnApplicationQuit` sends a kill signal; bridge's own watchdog also exits when `KSP_x64.exe` disappears for 3 polls. |

## Why the audio path is asymmetric

- **Cheap pilot side**: KSP runs in Unity. Loading PortAudio + WebRTC into a
  Unity process is hostile (audio device contention, native crash bundles,
  GC pressure). Doing it in a separate Node process keeps the simulation
  stable.
- **Expensive tower side**: the controller is in a browser already, where
  WebRTC is free. Mic capture, AudioWorklet DSP, and mixing are native to
  the platform.
- **Net result**: pilot hears anyone in the room (mixed by the bridge),
  pilot's voice goes "over the air" by piggybacking on the tower's
  WebRTC publish — triggered by a JSON packet over the data channel. Lossy in
  spirit, deterministic in practice.
