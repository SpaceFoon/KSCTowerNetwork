# KSCTowerNetwork

Voice, telemetry, ACARS text, and controller tools for Kerbal Space Program. Pilots run the game with the plugin; controllers use a browser. Each player keeps their own physics and save.

## Start here

| You want to… | Read |
| --- | --- |
| Host the backend and web app on a Linux VPS or Windows server | [Server hosting: prerequisites through first login](KSCTowerNetwork-dev/docs/SERVER_HOSTING.md) |
| Provision a fresh Ubuntu VPS, including its OS, firewall, TLS and services | [Ubuntu bootstrap guide](KSCTowerNetwork-dev/deploy/README.md) |
| Install optional Kerbin charts on your website | [Chart download and installation](KSCTowerNetwork-dev/docs/AEROCHART_REFERENCE.md) |
| Build or develop the game plugin, web app or player bridge | [Development](KSCTowerNetwork-dev/docs/DEVELOPMENT.md) |
| Choose required/optional player mods | [Mod integrations](KSCTowerNetwork-dev/docs/INTEGRATIONS.md) |
| Diagnose a problem or look up a setting | [Troubleshooting](KSCTowerNetwork-dev/docs/TROUBLESHOOTING.md), [settings](KSCTowerNetwork-dev/docs/SETTINGS_REFERENCE.md) |

## What runs where

**Server operator:** host the Node backend and static web app, with MariaDB, Redis, HTTPS and a LiveKit service. A Linux VPS works; no KSP installation, player bridge or Windows tooling belongs on this server. Bash and PowerShell entry points provide server-only setup/build/start. Start with the hosting guide above; running the backend alone does not serve the web interface.

**Controller:** open the operator's HTTPS website, register with an invite or use an account supplied by the operator, and join the controller queue from the Lobby. Voice needs browser microphone permission.

**Pilot:** install a built player release into KSP, point its settings at the operator's server, and sign in/pair as described in [deployment](KSCTowerNetwork-dev/docs/DEPLOYMENT.md#end-user-release-zip). This source checkout contains runtime templates, not a ready-to-play DLL or bundled bridge runtime. Build/package instructions are in Development; do not tell players to copy this repository into GameData.

## Source layout

| Directory | Contents |
| --- | --- |
| `KSCTowerNetwork-dev/` | C# plugin source, backend, web app, build scripts and docs |
| `KSCTowerNetwork-voice-bridge/voice-bridge/` | Player voice bridge source, tests and release builders |
| `GameData/KSCTowerNetwork/` | Runtime templates, patches, IVA props and kOS scripts |

Architecture and detailed reference: [project overview](KSCTowerNetwork-dev/docs/PROJECT_OVERVIEW.md) and [documentation index](KSCTowerNetwork-dev/docs/README.md). Maintainer publication checks are recorded in [repository setup](REPOSITORY_SETUP.md).

## Licenses and optional assets

Original code is under [MIT](LICENSE). Third-party material has separate terms in [NOTICE.md](NOTICE.md). Chart PDFs, rendered pages, transcripts and chart terrain SVGs are excluded; operators download/install charts separately under their source license. Font binaries and player game assets are also excluded.

The authenticated **Charts** page displays installation links when no bundle is installed, and the searchable viewer after installation.
