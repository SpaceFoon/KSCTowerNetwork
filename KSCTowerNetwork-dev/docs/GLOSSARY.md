# Glossary

Terms and acronyms used across the codebase, in design docs, and in the UI.

## Aviation / ATC

| Term | Meaning |
|---|---|
| **ACARS** | Aircraft Communications Addressing and Reporting System. In this project: text messaging between tower and pilot, in-game and web. |
| **AGL** | Above Ground Level. Altitude above terrain. Used for adaptive telemetry frequency (`TELEMETRY_CLOSE_AGL_M`). |
| **ASL** | Above Sea Level. Altitude above the body's reference. |
| **ATC** | Air Traffic Control. The role the controller (a.k.a. tower) plays. |
| **ATIS** | Automatic Terminal Information Service. Recorded broadcast of weather/runway info. See `ATIS_PLAN.md`. |
| **Callsign** | Pilot identifier (e.g. `BOBCAT 7`). Per-account. See `IDENTITY_PLAN.md`. |
| **Controller** | The role identifier in code for the tower operator. UI calls them "Tower". |
| **Flight strip** | Per-pilot card on the controller's desk with callsign, altitude, speed, squawk, etc. |
| **HullCam** | KSP mod that provides JPEG snapshots from cameras attached to vessels. Relayed by `TowerHullCamRelay`. |
| **JRTI HullCam** | The specific HullCam mod variant we integrate with. |
| **kOS** | Kerbal Operating System mod. Lets KerboScript programs control vessels. ACARS bridge talks to it via the kOS Archive. |
| **Kerbalizer** | Web-side mic DSP chain that gives the tower's voice the radio/cockpit comms quality. AudioWorklet + biquad fallback. |
| **Mayday** | Emergency state. Triggers squawk 7700 in the planned identity flow. |
| **Pilot** | The role identifier for users flying a craft. |
| **PTT** | Push-To-Talk. Key, RPM IVA switch, or kOS-driven mic gate. |
| **Runway state** | Current runway in use, wind direction, etc. See `REAL_TOWER_ROADMAP.md`. |
| **Squawk** | 4-digit transponder code, octal digits 0-7. Special: 1200 (VFR), 7700 (emergency), 7600 (radio failure), 7500 (hijack). |
| **VFR** | Visual Flight Rules. Default operating mode; squawk 1200. |

## Project-specific

| Term | Meaning |
|---|---|
| **Bridge** (unqualified) | The voice bridge Node process. |
| **Bridge identity** | LiveKit identity used by the voice bridge (`ksp_bridge` by default). Subscribe-only. |
| **Bridge runtime** | The bundled `node.exe` + compiled bridge under `PluginData/bridge-runtime/`. Distributed to end users so they don't install Node. |
| **Capability** | A finer-grained "may do X" string, derived from role. E.g. `chat:dm`, `mod:ban_perm`. |
| **Exchange code** | One-time short string minted by the web app to pair the in-game plugin with a user account. |
| **Ghost** | Pilot-to-pilot in-game craft visualization. See `GHOSTS_AND_TOWER_VIEW_PLAN.md`. |
| **Owner** | The single privileged role pinned by `OWNER_USER_ID`. Cannot be banned/demoted. |
| **Plugin session** | The long-lived `plugin_session` JWT held by the KSP plugin. |
| **Repository** (in code) | `backend/src/services/repository.ts`. The single data-access layer. |
| **Role** | One of `guest < pilot < controller < mod < supermod < owner`. |
| **Room** *(overloaded — three meanings, always disambiguate when writing)* | (1) **Tower session** — the lobby's "Tower room": a `sessionId` binding one pilot ↔ one controller, owns chat / strip / checklist / squawk / callsign. Created from `LobbyPage` via `POST /v1/session/call`. **This is what the user sees as "the room they joined".** (2) **Session voice room** — LiveKit room named `tower-{sessionId}`, ephemeral, 1:1 with a tower session. Holds the pilot's intra-session voice. (3) **Frequency voice room** — LiveKit room named `freq-{id}` (e.g. `freq-stock-ksc-tower`), persistent across sessions, introduced by `PER_FREQUENCY_CHANNELS_PLAN.md`. A user is in 1–3 of these regardless of whether they have a session. **Telemetry, hull-cam, chat, and strips are all scoped to (1); only voice uses (2) and (3).** Moving a user to a different *frequency room* never affects their *tower session*. |
| **Room name** | Human label on a tower session, set by the pilot at create-time (`POST /v1/session/call` body `name`) or via `PATCH /v1/session/:id`. Auto-derived from the callsign when unset (e.g. `SKYHAWK-A49 Tower`) — never a raw `tower-{UUID}`. Distinct from LiveKit room ids: **ops** voice uses `tower-{sessionId}`; **spectator booth** voice uses `tower-{sessionId}-booth` (same `sessionId`, separate SFU room). |
| **Booth (spectator)** | Side-channel chat + LiveKit voice for everyone in the tower session **except** the pilot. Web `BoothDesk`; token `flavor: "booth"`. Not mixed into the KSP bridge (bridge only subscribes to the ops room). |
| **Active room** | Server-truth answer to "is this user actually in a tower room right now?". The user is *active* in a session iff they are its pilot or its assigned controller AND `status !== "closed"`. Returned by `GET /v1/me/active-room` and polled by the SPA shell to (a) render the topbar room pill, (b) show/hide the Tower + Wall nav links, (c) gate the `/tower` and `/tower/wall` routes (no active room → bounce to `/lobby`), and (d) sync `localStorage[ksc_tower_chat_session_id]` so all the desks load the same session. The pre-2026 SPA derived this purely from a localStorage value, which let the topbar show stale session ids and let `/tower` mount on the `dev-shared` bootstrap session — voice "looked ready" while talking into an empty LiveKit room. |
| **Pilot idle close** | Background backend timer (`pilotIdleSessionSweep.ts`). When `lastTelemetryAt` for a tower session is older than `PILOT_IDLE_CLOSE_SECONDS`, the server calls the same soft-close as lobby **Close** (`status: closed`). Skips `dev-shared`, provisioned `ksc-radio-*` channels, `KSC-TOWER-*` hullcam ids, and sessions that never received telemetry. Set `PILOT_IDLE_CLOSE_SECONDS=0` to disable. |
| **Scorecard** | Computed pilot performance summary per session. Web mirror in `web/src/scoring/`. |
| **Session** | One ATC interaction between a pilot and a controller. Has an id, a callsign, a squawk, a status, etc. |
| **Tower** | The UI-facing name for a controller. Also the LiveKit room prefix (`tower-{sessionId}`). |
| **Tower web** | The web SPA's auth token type (`tower_web`). |
| **Voice bridge** | See "Bridge". The Node process that owns the LiveKit room from the KSP machine. |
| **World inventory** | Per-session catalog of vessels/runways/airfields published by the plugin and consumed by the web tower. |
| **World maps** | Per-session basemap layers (baked from KSP's planet textures). |

## File / directory shorthand

| Shorthand | Means |
|---|---|
| **`backend/`** | `KSCTowerNetwork-dev/backend/` |
| **`web/`** | `KSCTowerNetwork-dev/web/` |
| **`PluginSrc/`** | `KSCTowerNetwork-dev/PluginSrc/` |
| **`bridge/`** | `KSCTowerNetwork-voice-bridge/voice-bridge/` |
| **`runtime/`** | `GameData/KSCTowerNetwork/PluginData/bridge-runtime/` |
| **mod root** | `GameData/KSCTowerNetwork/` |
| **dev workspace** | `KSCTowerNetwork-dev/` |

## Acronyms

| Acronym | Expansion |
|---|---|
| **AVC** | KSP **Add-on Version Checker** (optional player mod). Reads `KSCTowerNetwork.version` JSON beside the DLL for version, KSP compatibility, and in-game update checks when `URL` is set correctly. Maintainer notes: [`ckan/README.md`](../ckan/README.md). |
| **CKAN** | Comprehensive Kerbal Archive Network — mod installer + catalog. |
| **DPAPI** | Data Protection API (Windows). Used by `TowerSecureStore` to encrypt the cached JWT. |
| **DSP** | Digital Signal Processing. The Kerbalizer is a DSP chain. |
| **HMR** | Hot Module Replacement. Vite's incremental update mechanism. |
| **HPF** | High-Pass Filter. First stage of the Kerbalizer. |
| **IMGUI** | Immediate-mode GUI. Unity's `OnGUI` style; what the in-game plugin panels use. |
| **IVA** | Internal View Activity. The cockpit interior view in KSP, where RPM lives. |
| **JWT** | JSON Web Token. App-issued bearer format. |
| **LK** | LiveKit. |
| **MM** | ModuleManager. KSP's config-patching mod, used by our `Patches/`. |
| **NetKAN** | CKAN's metadata bot/repo (`.netkan` → catalog entries). |
| **PCM** | Pulse-Code Modulated audio. The wire format on `127.0.0.1:47372` (s16le, 48 kHz, mono). |
| **RPM** | RasterPropMonitor. KSP mod for IVA cockpit interactivity, including PTT switches. |
| **SFU** | Selective Forwarding Unit. LiveKit's media routing model. |
| **SPA** | Single-Page Application. The React web frontend. |
| **TLS** | Transport Layer Security. `towerApiTls = True` in the plugin uses HTTPS/WSS. |
| **TPS** | Telemetry per second. Backend's adaptive cadence. |
| **TTL** | Time To Live. JWT and HullCam frame staleness use this. |
