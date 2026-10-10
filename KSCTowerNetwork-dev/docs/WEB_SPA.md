# Web SPA

Single-page React 18 app. Vite for dev/build. TypeScript everywhere. From the dev workspace, `npm run typecheck --prefix web` runs strict TypeScript validation; `npm run build --prefix web` requires it to pass before bundling with Vite.

Source root: `web/src/`

## Top-level layout

```
web/src/
├── main.tsx                  # ReactDOM.createRoot, mounts <App/>
├── App.tsx                   # Router, auth gate, top-level routes
├── index.css                 # Global styles (50 KB; the main visual system)
├── vite-env.d.ts
├── api/
│   ├── client.ts             # apiFetch() wrapper: auto auth header, JSON, errors
│   └── devVoice.ts           # x-ksc-voice-identity dev header helper
├── auth/
│   └── session.ts            # localStorage session cache + getToken/getUser/clear
├── audio/                    # Kerbalizer DSP chain (mic effect)
├── components/               # Cross-page reusable UI
├── data/                     # Static + lazily-loaded reference data
├── pages/                    # Route components
├── scoring/                  # Pilot scorecard rules (web mirror of backend)
├── session/                  # Session-shared widgets (countdown, checklist, scorecard)
└── voice/                    # LiveKit hooks + types
```

## Routes

Router is in `App.tsx`. Routes:

| Path | Component | Required role |
|---|---|---|
| `/login` | `LoginPage` | none |
| `/lobby` | `LobbyPage` | pilot+ |
| `/room/:id` | `RoomPage` | participant of session, or admin |
| `/dm` | `DmDesk` | `chat:dm` capability |
| `/tower` | `TowerPage` → `TowerDesk` | controller+ |
| `/tower/wall` | `TowerWallPage` → `TowerWall` (same component as desk embed) | controller+ |
| `/tower/wall/row` | `TowerWallRowPopoutPage` — one popped-out wall row | controller+ |
| `/admin` | `AdminDesk` | mod+ |
| `/voice` | `VoiceDesk` | dev voice testbed (open in dev) |
| `/chat` | `ChatDesk` | pilot+ |

The lobby's **`GET /v1/lobby/rooms`** list omits soft-closed sessions. Besides
the pilot/controller **Close** button, the backend may close a room after
telemetry silence (`PILOT_IDLE_CLOSE_SECONDS` / `PILOT_IDLE_SWEEP_INTERVAL_SECONDS`
in [SETTINGS_REFERENCE.md](SETTINGS_REFERENCE.md#telemetry)) — see
[TROUBLESHOOTING.md → Lobby and tower sessions](TROUBLESHOOTING.md#lobby-and-tower-sessions).

`AppShell.tsx` wraps every authenticated route with the persistent header
(role/callsign/logout, navigation links, mute/PTT indicators).

## Auth flow (web side)

1. `LoginPage` posts to `/v1/auth/login` with `{ email, password,
   callsign? }` / `{ displayName? }` (same field).
2. Response includes `{ token, user: { userId, role, capabilities, … } }`.
3. `auth/session.ts` writes both into `localStorage` under
   `ksc.session.v1`.
4. Every subsequent fetch goes through `api/client.ts`'s `apiFetch()`, which
   attaches `Authorization: Bearer <token>` and parses JSON.
5. On any 401 the wrapper clears the session and redirects to `/login`.
6. On `/auth/me`, the server returns the canonical role + capabilities; the
   client uses that, never a derived guess.

## Voice (LiveKit)

`voice/livekit.ts` wraps `livekit-client` for the SPA:

- **`requestLiveKitToken(sessionId, flavor?, signal?)`** — `POST /v1/session/:id/livekit-token` with body `{ flavor }`. Flavors: **`ops`** (tower mix, `tower-{sessionId}`), **`booth`** (spectator room, `tower-{sessionId}-booth`), **`lobby_ops`** (subscribe-only ops mix from the lobby).
- **`connectVoiceRoom(options)`** — `Room.connect`, optional `customMicTrack` publish (Kerbalizer output), optional Krisp (`noiseCancellation`), remote `<audio>` attach into `audioContainer`, `ksp_ptt` data handler, and teardown that clears room listeners + incoming meter RAF.
- **`VoiceRoomHandle`** — `setMicEnabled`, `setMicSource` (hot-swap publish track), `setNoiseCancellation`, `subscribeIncomingLevel(cb)` (0–1 peak-ish level each animation frame), `disconnect`.

`useLiveKitSessionCaps()` (in `session/`) polls server caps so the UI can react when publish/subscribe or room name drift without a full reload.

### Incoming level meter (web)

`connectVoiceRoom` registers `RoomEvent.TrackSubscribed` for remote **audio**, attaches playback, then builds a per-track Web Audio **Analyser** via LiveKit’s `createAudioAnalyser`. The meter combines:

- LiveKit participant **`audioLevel`** / speaking hints, and  
- **`max`**(LiveKit’s frequency-domain `calculateVolume()`, **time-domain RMS** from `getFloatTimeDomainData`) so normal speech still moves the bar when the frequency reader is flat or the analyser’s `AudioContext` was briefly **suspended** (awaited `resume()` after creation).

**`pages/VoiceDesk.tsx`** (ops / wall embed): subscribes to `subscribeIncomingLevel` and shows **Incoming** + local TX monitor.

**`pages/BoothDesk.tsx`** (spectator booth): separate LiveKit connection to the **booth** room; same `connectVoiceRoom` + **`subscribeIncomingLevel`** when `canSubscribe`, UI label **Incoming (spectators)**.

The in-game bridge still mixes **ops** room audio for KSP; booth is browser-only.

### Kerbalizer vs Krisp (send path)

The tower **Kerbalizer** is optional send-path DSP (`audio/kerbalizer*.ts`) producing a processed `MediaStreamTrack` for `publishTrack`. **LiveKit Krisp** must not run on that processed track (it expects a raw mic) — `VoiceDesk` disables Krisp while Kerbalizer is on and restores it when Kerbalizer is off. Two UI checkboxes: **Kerbalizer** (master chain on/off) vs **Kerbal voice** (optional chipmunk pitch layer in `KerbalizerControls.tsx`).

The tower controller's mic **may** go through the **Kerbalizer** when enabled:

```
Browser mic
  → MediaStreamSource
  → AudioWorklet (kerbalizerProcessor.worklet.ts)
       ├── biquad HPF
       ├── biquad band-pass
       ├── soft saturation (waveshaper-style)
       └── formant-shift (sample-and-hold + delay)
  → MediaStreamDestination
  → LocalParticipant.publishTrack
```

`audio/kerbalizerFallback.ts` exists for browsers that block AudioWorklet
(rare in 2026, but Safari quirks). It uses chained biquads only — no
formant shift.

`KerbalizerControls.tsx` (in `audio/`) renders strength / wet / character
sliders, **Kerbal voice** (pitch), and send-path meters. `meters.ts` has
helpers used by the Kerbalizer graph.

## Pages worth knowing

### `TowerDesk.tsx` (~90 KB, the cockpit)

Single-pane controller workstation. Features:

- Map (Leaflet-style on a baked KSP basemap from `worldMapsClient`).
- Per-pilot flight strips (callsign, alt, speed, distance, squawk).
- Active LiveKit room presence + per-participant volume.
- HullCam panel (latest snapshot per camera).
- Active checklist + countdown driven by `session/CountdownPanel.tsx` (pilot **Ready for countdown**; controller **Start / Scrub**, **Dismiss launch request**, takeoff **Cleared for takeoff / Dismiss** via `POST /v1/session/.../pilot-pending/handle`).
- Scorecard preview.
- Inline ACARS chat with the active pilot.
- After **Assume control**, structured **clearances** (`ClearancePanel.tsx`),
  approach sequence / separation conflicts, runway occupancy, phase timeline
  (Zulu), and recent RP violations (from live `active-aircraft` + tower hooks).
- Embeds **`TowerWall`** at the top when a session id is present (see below).

This file is intentionally a single component. Splitting it has been tried
and made the data flow harder to follow. If you must split, make sure the
refresh/animation loops still drive a single render tree.

### `TowerWall.tsx` (monitor wall)

Rows × cells of **pickable sources** (hullcam grid, body map, ACARS, voice,
countdown, kOS, etc.). Layout is persisted in `localStorage` per `persistKey`
(desk vs standalone `/tower/wall`). Countdown cells use **`useTowerLiveSubscriptions(sessionId)`** so `session.detail` can update over **`/v1/live/ws`** without relying only on HTTP polling.

**Pilot cards (game link + vessel):** the `status` slot lists active pilot rooms from
`/v1/lobby/rooms` and renders a **compact card per pilot session** (tracked
session first). Cards are **player-first in the UI**: primary line prefers ATC
`callsign`, then Kerbal `pilotName` from telemetry once loaded, then the lobby
session title; the subtitle carries MHz (when present), room title if it
differs from the primary line, and `pilotUserId` only when the API exposes it
(mod / own session — see `/v1/lobby/rooms` identity rules). Each card still uses
`/v1/session/:roomId` for flight-status pill, takeoff / countdown requests, link
health, and the numeric vessel snapshot the old **Telemetry table** cell showed.
The default layout uses **`status`** next to countdown, not a duplicate
telemetry-only column. Saved layouts may still contain `kind: "telemetry"`; the
UI and picker treat it as the same panel as `status`.

**Tower station status:** the `active-roster` slot is the channel/station view,
not a second pilot roster. It combines `/v1/site/info` radio presets with
`/v1/lobby/rooms` and renders one row per configured station (`TWR`, `GND`,
`ATIS`, `EMRG`) with its MHz, any pilot sessions currently on that frequency,
and whether a controller is assigned.

### Flightwall radar and craft photo

The existing `tower-radar` source is labeled **Flightwall (radar + craft photo)**.
Saved slots retain their session bindings and airfield origin. `TowerRadarScope.tsx`
pairs the 100 km PPI with `FlightWallCard.tsx`: green heading-oriented
plane/rocket/rover markers and range boundary, with an amber selected track.
The radar uses a green phosphor face; surrounding panels, text and accents use
the shared site theme (slate panels, muted text and amber highlights).
Select a marker with click/Enter/Space or use the craft buttons under the radar.
The tracked pilot is selected initially; when a selected track disappears, it
falls back to the tracked pilot or first track. Zoom, pan, sweep-painted trails
and the airfield picker remain available. Every return, including stationary
and selected craft, flashes when the leading sweep line crosses it and fades
between passes. Labels and the selection ring stay readable. Beam crossings
are detected across skipped frames so slow rendering does not miss a repaint.
Narrow cells stack and scroll.
Reduced motion disables the sweep, paints positions directly and retains a
one-second freshness check.

The card shows pilot/craft identity, airfield-relative direction/distance,
reported runway, altitude ASL (m), surface/vertical speed (m/s), and heading.
Guidance compares heading with the radial bearing from the selected airfield;
it is a directional hint, not proof of closest approach or visual visibility.
Unknown destinations stay explicit. Self-track freshness uses server session
health and its threshold; other tracks use server receipt time and the
active-aircraft snapshot's freshness window and health state (including paused
or beacon-off pilots). Failed queries show stale details.

The image is a **saved craft thumbnail**, not a live HullCam frame. The card
polls `/v1/craft-thumbnail/:sessionId?craftName=...` with `apiFetchResponse`
every 15 seconds and releases object URLs on replacement/unmount. Changing
session or craft immediately removes the previous image. Missing images show
a neutral silhouette and a save-in-editor hint. Staging/docking can change the
craft after its editor thumbnail was saved.

`/flightwall-preview.html` uses the real radar/card components with labeled
sample telemetry and Traffic/Stale/No traffic controls. Its thumbnail requests
use the real API, so an unseeded preview shows the missing-photo state. This is
a Vite review entry, not a production route or real pilot session. Its
**Preview saved thumbnail** file picker can display a local PNG on the sample
KERBAL-7 card without uploading it; that state is labeled **Local thumbnail
preview** and does not prove the authenticated relay.

### `RoomPage.tsx`

The pilot-side equivalent: chat with the assigned controller, voice room
membership, scorecard. Used by browser-only "co-pilots" too.

### `AdminDesk.tsx`

Mod/owner tools: ban table, report queue, role grant, room list, log
viewer. Uses `requireRole("mod")` server-side; clientside duplicates the
gate so unauthorized links don't render.

### `LobbyPage.tsx`

Public-ish landing for authenticated pilots. Active sessions, "join
queue" button (calls `POST /v1/queue/join`), lobby chat.

### `DmDesk.tsx`

1:1 messaging. Uses `chat:dm` capability. Threads list comes from
`/v1/dm/threads`; conversation from `/v1/dm/messages?with=<userId>`.

## State management

No Redux, no Zustand, no Recoil. Just React state + a few hand-rolled
custom hooks:

- `useLiveKitSessionCaps` — combines token claims + participant metadata.
- `formatApiError` (in `session/`) — turns `apiFetch` errors into
  user-readable strings.
- Session cache in `localStorage` is read once at mount and pushed back on
  every meaningful change.

If you need shared state across two pages, lift it to `App.tsx` or to a
custom hook in `session/`. Don't introduce a state library.

## API client

`api/client.ts` is the **only** allowed `fetch` callsite. Every page
imports `apiFetch` from there. Reasons:

- Auto-attaches the bearer token from `auth/session.ts`.
- Parses JSON, normalizes errors.
- Honors `signal` for `AbortController` cancellation.
- Dev: forwards `x-ksc-voice-identity` from `devVoice.ts` so two browser
  tabs can simulate `pilot` vs `controller` against the same dev backend.

If you need raw `fetch` for streaming/binary, add a sibling helper in
`api/`, don't bypass `apiFetch` ad hoc.

## Dev server (Vite)

`vite.config.ts` proxies `/v1/*` to `http://127.0.0.1:48787` so the SPA can
make same-origin API calls during dev. Production builds emit a static
bundle (`web/dist/`); the SPA must be served from a domain whose origin is
in the backend's `CORS_ORIGINS` allowlist.

## Reference data

- `data/kerbinLaunchSites.ts` — KSC, island, etc., with lat/lon.
- `data/kerbinNavaids.ts` — VORs/NDBs/fixes for the map overlay.
- `data/worldInventoryClient.ts` — wraps `/v1/world-inventory/:sessionId`.
- `data/worldMapsClient.ts` — wraps `/v1/world-maps/:sessionId/layer/:id`.

These are deliberately thin shims so the static data and the dynamic API
are interchangeable from the page's perspective.

## Optional chart reference

The authenticated `/charts` route shows download and installation links when no bundle is installed. Server owners download the original ASET PDF separately and run `web/scripts/install_charts.py` after building the web app. Generated files go into `dist/charts/` (or an explicit output directory), served at `/charts/`. Once installed, the viewer provides 22 pages, full-document search, section filters, transcripts, PDF links and reference-data download. Third-party chart assets and transcripts are excluded from source control and retain CC BY-NC-SA 3.0. See [installation instructions](AEROCHART_REFERENCE.md).

The production `/charts` route requires sign-in and is available through the Charts navigation link; it does not require an active room.

## Solar-system artwork and planet globes

`components/SystemSchematic.tsx` uses `SystemArtwork.tsx` for the starfield and
shaded overview markers. Selecting a body opens an inspector with the WebGL
`PlanetGlobe.tsx` renderer: rotating terrain, separate cloud layers, OPM rings,
optional illustrative radiation belts, drag/keyboard rotation, zoom, pause,
and an expanded dialog. Reduced-motion preferences disable automatic rotation.
The inspector overlays wide scenes and flows below narrow panels.

`data/globeTextures.ts` selects textures from the generated
`globeAssetSources.ts` registry, guarded by stock/OPM world ID. A matching live
PNG terrain layer takes priority. Local `public/globes/` textures are optional
and ignored; provenance and license notices remain tracked. Import from your
own KSP/AVP installation with `scripts/import-globe-textures.py`; see
[the asset README](../web/public/globes/README.md) and [NOTICE.md](NOTICE.md).
Missing image files use the renderer's illustrated fallback.

`/globe-preview.html` is a development-only gallery for stock and OPM bodies.
The production build uses the normal authenticated Tower Desk route.
