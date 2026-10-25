<div align="center">
  <h1>🚀 KSCTowerNetwork</h1>
  <p><img src="KSCTowerNetwork-dev/web/public/ksc-tower-social-preview.jpg" alt="KSC Tower website preview" width="520"></p>
  <p>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/releases"><img src="https://img.shields.io/github/v/release/SpaceFoon/KSCTowerNetwork?include_prereleases&label=latest%20release&style=for-the-badge&labelColor=172B46&logoColor=white&logo=github" alt="Latest release"></a>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/releases"><img src="https://img.shields.io/github/downloads-pre/SpaceFoon/KSCTowerNetwork/total?label=downloads&style=for-the-badge&labelColor=172B46&logoColor=white&logo=github" alt="Release downloads"></a>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SpaceFoon/KSCTowerNetwork?style=for-the-badge&labelColor=172B46&logoColor=white" alt="License"></a><br>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/actions/workflows/coverage.yml"><img src="https://img.shields.io/github/actions/workflow/status/SpaceFoon/KSCTowerNetwork/coverage.yml?branch=main&label=coverage%20checks&style=for-the-badge&logo=githubactions&labelColor=172B46&logoColor=white" alt="Coverage checks"></a>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/issues"><img src="https://img.shields.io/github/issues/SpaceFoon/KSCTowerNetwork?label=open%20issues&style=for-the-badge&labelColor=172B46&logoColor=white&logo=github" alt="Open issues"></a>
    <a href="https://github.com/SpaceFoon/KSCTowerNetwork/commits/main/"><img src="https://img.shields.io/github/last-commit/SpaceFoon/KSCTowerNetwork/main?label=updated&style=for-the-badge&labelColor=172B46&logoColor=white&logo=github" alt="Last updated"></a>
  </p>
  <p><strong>Voice, telemetry, ACARS text, and controller tools for Kerbal Space Program.</strong></p>
  <p>Pilots run the game with the plugin; controllers use a browser.<br>Each player keeps their own physics and save.</p>
  <p>
    <strong><a href="#downloads-and-releases">Downloads and releases</a></strong> &nbsp;·&nbsp;
    <strong><a href="#what-runs-where">What runs where</a></strong> &nbsp;·&nbsp;
    <strong><a href="#start-here">Start here</a></strong><br>
    <a href="#source-layout">Source layout</a> &nbsp;·&nbsp;
    <a href="#licenses-and-optional-assets">Licenses and optional assets</a>
  </p>
</div>

<a name="downloads-and-releases"></a>

## 📦 Downloads and releases

> [!TIP]
> A release provides separate **Client** (Windows x64 KSP plugin + voice bridge) and
> **Server** (built backend + website) ZIPs.

Controllers use the hosted website. See [release build and installation](KSCTowerNetwork-dev/docs/RELEASING.md).


**[Browse release downloads →](https://github.com/SpaceFoon/KSCTowerNetwork/releases)**

<a name="what-runs-where"></a>

## 🛰️ What runs where

<table>
  <tr>
    <th align="left" valign="top" width="130">🎙️ Controller:</th>
    <td><p>open the operator's HTTPS website, register with an invite or use an account supplied by the operator, and join the controller queue from the Lobby. Voice needs browser microphone permission.</p></td>
  </tr>
  <tr>
    <th align="left" valign="top">🧑‍🚀 Pilot:</th>
    <td><p>install a built player release into KSP, point its settings at the operator's server, and sign in/pair as described in <a href="KSCTowerNetwork-dev/docs/DEPLOYMENT.md#client-and-server-release-zips">deployment</a>. This source checkout contains runtime templates, not a ready-to-play DLL or bundled bridge runtime. Build/package instructions are in Development; do not tell players to copy this repository into GameData.</p>
<p>Pilots use the same Client ZIP and set their operator's address in <code>GameData/KSCTowerNetwork/PluginData/settings.cfg</code>. Operators do not need to rebuild or repackage the client for each server. </p></td>
  </tr>
  <tr>
    <th align="left" valign="top">🛠️ Server operator:</th>
    <td><p>Use the Ubuntu installer for a fresh VPS or VM. It installs and configures the backend, website, database/cache, HTTPS and service startup. Existing hosts and Windows servers can use the manual hosting guide.</p></td>
  </tr>
</table>

<details>
<summary><strong>Host a tower on Ubuntu</strong></summary>

Start with a fresh Ubuntu 22.04 or 24.04 LTS VPS or VM. Configure the installer
with your hostname, SSH key, owner login and voice settings, then run
`sudo bash setup-vps.sh`. It installs Node, MariaDB, Redis and nginx, builds
the backend and website, configures HTTPS and the firewall, and starts the
backend as a systemd service. It writes the production environment to
`/etc/ksctower.env`. Cloudflare is optional; direct HTTPS is supported.

Follow the [Ubuntu installer guide](KSCTowerNetwork-dev/deploy/README.md).
For an Ubuntu VM, give it a reachable address and forward the required ports.
Voice uses the LiveKit service configured in your server settings.

</details>

<a name="start-here"></a>

## 🚀 Start here

| **You want to…** | **Read** |
| --- | --- |
| Join the controller queue from the operator's website | [Controller overview](#what-runs-where) |
| Install the KSP client, sign in, and pair with an operator | [Pilot deployment](KSCTowerNetwork-dev/docs/DEPLOYMENT.md#client-and-server-release-zips) |
| Use the prebuilt server or set up an existing Linux/Windows host manually | [Server hosting: prerequisites through first login](KSCTowerNetwork-dev/docs/SERVER_HOSTING.md) |
| Install a complete backend and website on a fresh Ubuntu VPS or VM | [Ubuntu bootstrap guide](KSCTowerNetwork-dev/deploy/README.md) |
| Install optional Kerbin charts on your website | [Chart download and installation](KSCTowerNetwork-dev/docs/AEROCHART_REFERENCE.md) |
| Build or develop the game plugin, web app or player bridge | [Development](KSCTowerNetwork-dev/docs/DEVELOPMENT.md) |
| Choose required/optional player mods | [Mod integrations](KSCTowerNetwork-dev/docs/INTEGRATIONS.md) |
| Diagnose a problem or look up a setting | [Troubleshooting](KSCTowerNetwork-dev/docs/TROUBLESHOOTING.md), [settings](KSCTowerNetwork-dev/docs/SETTINGS_REFERENCE.md) |


<a name="source-layout"></a>

## 🗂️ Source layout

| **Directory** | **Contents** |
| --- | --- |
| `KSCTowerNetwork-dev/` | C# plugin source, backend, web app, build scripts and docs |
| `KSCTowerNetwork-voice-bridge/voice-bridge/` | Player voice bridge source, tests and release builders |
| `GameData/KSCTowerNetwork/` | Runtime templates, patches, IVA props and kOS scripts |

Architecture and detailed reference: [project overview](KSCTowerNetwork-dev/docs/PROJECT_OVERVIEW.md) and [documentation index](KSCTowerNetwork-dev/docs/README.md). Maintainer publication checks are recorded in [repository setup](REPOSITORY_SETUP.md).


<a name="licenses-and-optional-assets"></a>

## ⚖️ Licenses and optional assets

Original code is under [MIT](LICENSE). Third-party material has separate terms in [NOTICE.md](NOTICE.md). Chart PDFs, rendered pages, transcripts and chart terrain SVGs are excluded; operators download/install charts separately under their source license. Font binaries and player game assets are also excluded.

The authenticated **Charts** page displays installation links when no bundle is installed, and the searchable viewer after installation.
