# Host a KSC Tower Network server

## Fresh Ubuntu VPS or VM

Configure the installer and run it on a fresh Ubuntu 22.04 or 24.04 LTS server.
Follow the [Ubuntu installer guide](../deploy/README.md):

```bash
sudo bash setup-vps.sh
```

The CONFIG block supplies your hostname, SSH key, owner login, signup policy
and voice settings. The installer installs Node, MariaDB, Redis and nginx,
builds the backend and website, configures HTTPS and the firewall, writes
`/etc/ksctower.env` and starts the backend as a systemd service. It uses
your configured LiveKit service for voice. Cloudflare is optional; direct
Let's Encrypt HTTPS is supported. A VM needs a reachable address and the
required ports forwarded.

## Existing hosts and prebuilt releases

Use [SERVER_HOSTING.md](SERVER_HOSTING.md) for the prebuilt Server ZIP or manual
Linux/Windows setup. These are alternative paths, not additional installation
steps after the Ubuntu installer. For a prebuilt release, the server launcher
uses backend/.env.production unless you supply a different private env file.

## Connect players

Controllers open your HTTPS website and sign in. Pilots install the standard
Windows x64 Client ZIP from [GitHub releases](https://github.com/SpaceFoon/KSCTowerNetwork/releases) and set your hostname,
port, TLS and API path in GameData/KSCTowerNetwork/PluginData/settings.cfg.
They then sign in/pair and verify telemetry and voice. Preserve their settings.cfg
and auth.cfg on upgrades. No server-specific client build is needed.

Maintainer release builds are documented separately in [RELEASING.md](RELEASING.md).
