# KSC Tower Network — Mod Integrations

Which other KSP mods does KSC Tower Network work with, what does each one give you, and which do you actually need? Read this once before deciding what to install alongside the tower mod.

If you installed via **CKAN**, the recommended set is already offered to you with check-boxes — this document explains *why* each one is in the list, so you can make an informed call about which to keep.

---

## TL;DR

| You want… | Install at minimum |
|---|---|
| A tower mod that loads and lets you talk to controllers via the web tower | Just `KSCTowerNetwork` + `ModuleManager` |
| The above, with no risk of clicking through your radio panel onto your rocket | Add `ClickThroughBlocker` |
| In-cockpit (IVA) push-to-talk button + frequency dial | Add `RasterPropMonitor` + `ASETProps` + `ASETAvionics` (or `AvionicsSystems` for MAS cockpits) |
| kOS scripts that read tower clearances and that mirror your kOS terminal to the web tower | Add `kOS` |
| Live HullCam snapshots forwarded to the web tower so ground control can see your camera feed | Add `HullcamVDSContinued` + `JustReadTheInstructions` |
| Live radiation rad/s on the controller's strip | Add `Kerbalism` |

Everything is optional except `ModuleManager`. The mod *runs* without any of the integrations; you just lose the matching feature.

---

## Required

### ModuleManager
**Status:** hard `depends`. The mod **will not function** without it.

KSCTowerNetwork ships two MM patches under `GameData/KSCTowerNetwork/Patches/`:
- `MM_HookCommRadio.cfg` — adds our PTT + frequency-sync modules to the existing ASET / MAS COMM radio props.
- `MM_AddTowerMicProp_DE_mk1Cockpit.cfg` — auto-places the PTT button into the DE Mk1 cockpit IVA next to the Chatterer PTT.

Both files use pure ModuleManager syntax (`@PROP`, `:NEEDS`, `:AFTER`, `:FINAL`). Without ModuleManager.dll loaded, they're inert text files.

---

## Strongly Recommended

### ClickThroughBlocker
**Status:** `recommends`. Mod loads without it; behavior just degrades.

In flight scene the tower mod draws four IMGUI windows: the radio dial, the checklist, the ACARS pad, and the launch countdown HUD. Without ClickThroughBlocker, a click on those windows can pass through to the part underneath — meaning a click on the radio dial could accidentally fire your stage, toggle a fairing, or activate an action group.

We wire ClickThroughBlocker via runtime reflection (`PluginSrc/TowerClickBlock.cs`), so the mod still compiles and runs without it. You just get the leaky vanilla `GUI.Window` behavior. **Strongly recommended for anyone who actually flies.**

The KSP log will print `[KSCTowerNetwork] ClickThroughBlocker bound: ...` on first window draw if the integration is active.

---

## IVA / Cockpit Stack (Recommended)

This is the immersion stack: an in-cockpit push-to-talk button you can hold in IVA, and a COMM radio dial that switches your tower frequency / room. **None of this is required for core ATC operations** — keyboard PTT and the web tower's frequency picker do the same job — but the in-cockpit version is the whole point of playing in IVA.

If you rip the entire IVA stack out, you lose: in-cockpit PTT button, in-cockpit frequency dial. You keep: keyboard PTT, web tower, frequency selector, telemetry, voice, clearances, ACARS, kOS bridge, HullCam relay.

### RasterPropMonitor
The PTT prop (`pb_KSCTOWER_mic_PTT`) uses RPM's `JSIActionGroupSwitch` to call into our plugin. The ASET COMM radio prop we patch is also an RPM prop. Without RPM there's no clickable in-IVA PTT button.

### ASETProps
Provides the physical button models (`pb_Full_Cap_White`, `pb_Collider`) and the click sound (`pb_Push02`) used by the PTT prop.

### ASETAvionics
Ships `ASET_COMM_Radio` — the cockpit COMM radio instrument. We patch our `KSCTowerCommRadioPtt` and `TowerCommRadioFreqSync` modules onto it so turning the dial in the cockpit changes which tower frequency / room you're on.

### AvionicsSystems (MAS)
The MOARdV alternative to RPM. We patch our modules onto the `MAS_ASET_COMM_Radio` variant the same way. **Recommended only if you fly MAS-equipped cockpits** — RPM and MAS cockpits are mutually exclusive choices.

---

## Functional Integrations (Recommended)

These are real, advertised features of the mod. Each is one-way (we read from the other mod, we never modify its state) and gracefully no-ops when the mod is absent.

### kOS
Two integrations:

1. **ACARS file-mailbox bridge** (`PluginSrc/TowerAcarsKosBridge.cs`). The plugin polls a folder under your kOS Archive volume (default `Ships/Script`) every 3 seconds. kOS scripts can write `*.txt` files there to file ACARS reports up to the tower; the plugin can also drop incoming clearances into the same archive so kOS scripts can read them. Auto-installs a small `acars.ks` helper library on first run.
2. **kOS terminal mirror** (`PluginSrc/TowerKosScreenAutoCapture.cs`). Reflectively walks every active kOS CPU's `IScreenBuffer` and forwards changed lines to the web tower's kOS screen panel, so a controller can watch what the pilot's autopilot script is printing. Player-toggleable via the in-game `KOS` button on the radio HUD.

### HullcamVDSContinued + JustReadTheInstructions
**These two are a pair.** JRTI by itself does nothing useful here; it just exposes Hullcam VDS Continued's camera PartModule (`MuMechModuleHullCamera`) over a local HTTP endpoint.

The plugin (`PluginSrc/TowerHullCamRelay.cs`) polls **`{HullCamJrtiBaseUrl}/cameras`** (default `http://127.0.0.1:8080/cameras`) once every 5 seconds, then snapshots each discovered camera at **1–2 Hz**, and **POST**s the JPEG bytes to **`ApiBaseUrl`** (`/v1/hullcam/{sessionId}/{cameraId}`). The JRTI hop is plain **HTTP on localhost** — that is the mod's protocol, not a choice the tower plugin can upgrade to TLS. The web tower's `HullCamPanel` then **GET**s `/v1/hullcam/.../snapshot.jpg` on a timer using the same bearer token as the rest of the SPA (so the browser scheme follows your deployed API: `http` or `https`). Server-side caps, caching, and CPU/RAM trade-offs are documented in [BACKEND.md → HullCam pipeline](BACKEND.md#hullcam-pipeline).

Camera mods that don't go through the standard `MuMechModuleHullCamera` PartModule (e.g. Neptune Camera, KURS DockingCam) are **not** supported — they'd need their own GPU readback path.

Player-toggleable via the in-game `CAM` button on the radio HUD. Off by default to avoid the local HTTP poll when you're not using it.

**Tower lookout (`KSC-TOWER-*`).** Controllers who run a second KSP instance (or stay on the ground at KSC in flight) can publish that HullCam stream to the backend under a stable `KSC-TOWER-{hash}` session id using the radio panel **Stream as Tower** toggle. The web Tower Desk picks it up via `GET /v1/tower/view-streams` and the same HullCam tiles as pilot cameras. This path is **flight + HullCam + JRTI** only; it does **not** use the disabled Space Centre camera snap (`TowerJumpToWindow`). Setup hints: `GameData/KSCTowerNetwork/PluginData/TOWER_CAM_README.txt` and [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) Part B.

---

## Situational / Suggested

### DE_IVAExtension
**Only matters if you fly the DE Mk1 cockpit.** The patch `MM_AddTowerMicProp_DE_mk1Cockpit.cfg` auto-places the PTT prop next to the existing Chatterer PTT in that one IVA. If you don't fly DE Mk1, this patch never fires and the mod doesn't care whether DE_IVAExtension is installed.

### KSA IVA Upgrade
Adds full RPM/ASET IVAs (with the COMM radio prop) to the **stock** Squad pods. Without something like this, the COMM-radio frequency-sync integration only appears in the handful of pods that ship with ASET IVAs out of the box. If you want the in-cockpit frequency dial to work in stock Mk1 / Mk2 / Mk3 cockpits, install KSA IVA Upgrade. Borderline case for `recommends` — moved to `suggests` only because not every player flies stock IVAs.

### Reviva
Cockpit IVA chooser / swapper. Lets you swap between multiple IVA layouts on the same pod without re-installing mods. Our `MM_HookCommRadio.cfg` is deliberately ordered `:FINAL` so we slot in **after** Reviva rewrites the prop list — meaning the COMM-radio sync hooks survive a Reviva IVA swap. Pairs naturally if you collect IVAs.

### FreeIVA
Walk around inside cockpits in IVA. Doesn't add any new prop or radio capability of its own; it just makes the IVA stack feel like a place you inhabit instead of a static cockpit photo. If you're committed to the IVA experience this mod recommends, FreeIVA is the natural companion.

### kOSPropMonitor (kPM)
In-cockpit IVA prop that displays a kOS terminal screen. Pairs with our **kOS terminal mirror**: the same buffer that we forward to the web tower's kOS-screen panel is also visible inside the cockpit on a physical-looking display. If you fly with kOS scripts and want both pilots-in-cockpit and ground-controllers to see what the script is printing, install both.

### VesselView
Renders an exploded 2D schematic of the active vessel into a Toolbar window, with an optional in-IVA prop via **RasterPropMonitor** (the CKAN entry's `depends` on `RasterPropMonitor-Core` is what gates the IVA half). The CKAN id is `VesselView`; the human-readable name is "Vessel Viewer Continued" (linuxgurugamer's revival of PeteTimesSix's mod). Not used by our plugin directly today, but intended to pair with the future **Vessel Schematic** web tile (see `VESSELVIEW_INTEGRATION_PLAN.md`) — that tile is fed by a per-vessel parts manifest the plugin uploads, so it works whether or not the player has VesselView installed; VesselView itself is the in-game equivalent for pilots who want the same picture in their cockpit.

A poor-man's alternative for the schematic-style ground view, available **today** with zero new code: bolt a HullCam VDS Continued camera onto a long boom mounted top-down or iso over the vessel and stream it through the existing JRTI HullCam relay (see the **JustReadTheInstructions** integration above). The image isn't a labeled exploded schematic — it's the actual rendered vessel — but for "controller wants to see the inbound's planform" it's good enough until the Vessel Schematic tile lands.

### Kerbalism
Passive telemetry enrichment only. The plugin reflectively reads `KERBALISM.API.Radiation(Vessel)` once per telemetry tick and adds it to the strip view. There's no visible feature that breaks if Kerbalism is absent — the radiation field on the controller's strip just stays at zero. Worth installing if you're running RP-1 / RSS where radiation actually matters; otherwise skip.

### Chatterer
**Deliberately *not* recommended.** The whole point of KSCTowerNetwork is real human voice over LiveKit, not simulated background chatter. We don't *use* Chatterer for anything — the integration in `TowerChattererDuck.cs` is purely defensive: if Chatterer happens to be installed, we mute it (and the ASET COMM radio's built-in fake `ATC_001..ATC_020` samples) while your PTT is open so the chatter doesn't bleed into your real transmission. Set `blockChattererInFlight = True` in `settings.cfg` to keep those sources muted for the **entire** Flight scene instead. Recommending Chatterer would mean telling the user to install fake chatter just so we can silence it. Listed under `suggests` only so CKAN flags it as "we know this exists and we play nicely with it."

---

## What we do NOT integrate with

To pre-empt obvious questions:

- **Toolbar Controller (linuxgurugamer's blizzy-style toolbar)** — not used. We register a single button via stock `ApplicationLauncher`, no `ToolbarControl` wrapper anywhere. No CKAN entry needed.
- **Other camera mods** (Neptune Camera, KURS DockingCam, etc.) — not surfaced. The HullCam relay only sees what JRTI sees, and JRTI only sees `MuMechModuleHullCamera`.
- **Telemachus / RemoteTech / kOS Library mods (kOS-Communication, etc.)** — not used. Telemetry goes through our own publisher (`TowerTelemetryPublisher.cs`); we don't piggyback on Telemachus's HTTP server, and CommNet visibility is read directly from stock KSP.
- **Persistent rotation, FAR, Realism Overhaul, Principia, etc.** — neutral. We just publish whatever vessel state KSP reports; physics mods don't change the integration surface.

---

## Server-side caveat

CKAN installs the **client** mod only. The mod is useless without a backend tower server reachable at the URL configured in `GameData/KSCTowerNetwork/PluginData/settings.cfg`, plus a LiveKit project for voice. See `HOSTING.md` in the release ZIP if you want to host your own, or use a community-published preset whose `settings.cfg` points at someone else's tower.
