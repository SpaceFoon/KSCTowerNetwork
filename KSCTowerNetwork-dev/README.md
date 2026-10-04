# KSCTowerNetwork

Voice, telemetry, text (ACARS), and tower-side tooling for Kerbal Space Program — **no shared physics or save**; it is an ATC-style layer on top of normal KSP.

Developer docs: start with [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) and the index at [`docs/README.md`](docs/README.md).

---

## How it is meant to be used

Use it **however your group enjoys**. Some want heavy roleplay, some light RP, some just want a frequency to mess around on. There is no single “correct” session style.

What actually matters:

- **Agree on the vibe** — same rough expectations for structure, callsign discipline, and how “real” you want to sound.
- **Agree on the world** — stock Kerbin, RSS, a rebuilt KSC, plane packs, etc. Everyone runs their own game; maps and terrain only line up in a useful way when you are in a **similar** setup (or you accept that the picture is interpretive).

### Tower vs mission comms (words matter)

**Tower** (airfield): think **airport tower** — local traffic, pattern, runways, and the airfield under one facility’s watch. In real life one tower frequency usually covers **all runways at that airport**. For this mod, **default mental model: one tower for the whole space center** unless your group deliberately plays stricter (e.g. big events with multiple human seats).

**Mission / space comms** — orbit, transfers, reentry, “we’ve lost the link” drama: that is **mission control / CapCom-style** talk, not the same thing as **airport “Ground”** (taxi, apron, pushback). Casual players often say “ground” for anything planetside; that is fine **if the session agrees**. For clarity in docs and serious RP, prefer **mission control** or **CapCom** for the space side so it does not collide with future **Ground** = surface/taxi at the field (see [`docs/GROUND_SEAT_PLAN.md`](docs/GROUND_SEAT_PLAN.md)).

### Per-runway tower vs one tower

You do **not** need runway-to-runway tower handoffs for fun. Optional hardcore sessions can invent them; the simple default is **one tower position for the whole KSC** (like one field, many runways).

---

## Repo layout (quick)

| Path | Role |
|------|------|
| `../GameData/KSCTowerNetwork/` | What KSP loads (built artifacts; do not put source here). |
| `KSCTowerNetwork-dev/` (this tree) | Plugin source, backend, web SPA, build scripts, design docs. |
| `../KSCTowerNetwork-voice-bridge/` | Voice bridge source and packaging into `PluginData/`. |

Build and dev commands: [`docs/AGENTS.md`](docs/AGENTS.md).
