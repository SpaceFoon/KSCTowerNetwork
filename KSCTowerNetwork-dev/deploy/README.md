# KSCTowerNetwork — Deployment Guide

End-to-end guide for taking the project from local dev to a public, hardened, internet-reachable deployment that your buddy can join from anywhere.

> If you just want to run a one-off online test session with a remote buddy and you don't need a permanent server, skip this doc and use a Cloudflare Tunnel quick-tunnel against your local `npm run dev`. This guide is for the real thing.

---

For a VPS that already has Node, database/cache and a reverse proxy, use the lighter [server-only Bash/PowerShell commands](../docs/SERVER_HOSTING.md). They also support a Windows server.

## TL;DR

```bash
# 1. Provision a fresh Ubuntu 24.04 LTS VPS, point a DNS A record at it, get a
#    Cloudflare API token (4 scopes — see "Cloudflare API token" below).
# 2. Edit deploy/setup-vps.sh CONFIG block (~10 fields).
# 3. scp it to the VPS, run it as root.
scp deploy/setup-vps.sh root@<vps-ip>:/root/
ssh root@<vps-ip>
nano setup-vps.sh
bash setup-vps.sh
# 4. In a SECOND terminal, confirm:  ssh -p 22 tower@<your-domain>
# 5. Visit https://<your-domain>/ and log in.
# 6. Rebuild the KSP plugin DLL with the new ApiBaseUrl, ship it + the bridge
#    runtime to your buddy. Done.
```

The script handles: hardening, Node/nginx/MariaDB/Redis install, repo clone + build, systemd service, Cloudflare API automation (DNS, SSL settings, Origin Cert generation, Authenticated Origin Pulls), origin lockdown verification.

---

## Architecture

```
┌──────────────────┐                    ┌──────────────────────┐
│  Pilot's PC      │                    │  Buddy's PC          │
│  ──────────────  │                    │  ──────────────────  │
│  KSP + plugin    │                    │  Browser (tower UI)  │
│      │           │                    │      │               │
│  voice-bridge ───┼──── outbound ──────┼──────│ LiveKit Cloud │
│      │           │      WSS / RTC     │      │ (voice)       │
│      │ HTTPS     │                    │      │ HTTPS         │
└──────┼───────────┘                    └──────┼───────────────┘
       │                                       │
       │             ┌─────────────────────┐   │
       └─────────────│  Cloudflare edge    │───┘
                     │  (DNS proxied,      │
                     │   WAF, Bot Fight,   │
                     │   TLS termination)  │
                     └──────────┬──────────┘
                                │ TLS (Origin Cert + AOP)
                                │ ONLY CF IPs allowed by UFW
                     ┌──────────┴──────────┐
                     │  Your VPS           │
                     │  ─────────────────  │
                     │  nginx :443         │
                     │    ├─ /          → web/dist (vite build)
                     │    └─ /v1/*      → 127.0.0.1:48787
                     │  node backend       │
                     │    ├─ MariaDB       │
                     │    └─ Redis         │
                     └─────────────────────┘
```

Key facts:

- **Voice never transits your VPS.** LiveKit Cloud handles all audio. Your VPS handles HTTP API, web app, telemetry, chat, ACARS, KOS screens.
- **Cloudflare proxies everything.** Origin IP is hidden, UFW rejects connections from anyone outside Cloudflare's published IP ranges.
- **Single origin** (web + API on the same domain) → no CORS to debug.
- **TLS is end-to-end**: client → CF (CF cert) and CF → origin (Cloudflare Origin Cert, 15-yr validity, mutually authenticated via AOP).

---

## Prerequisites

You need:

| Thing | Where to get it | Cost |
|---|---|---|
| VPS, Ubuntu Server 24.04 LTS, ≥1 GB RAM | Hetzner CX22, Vultr, DigitalOcean, Linode, etc. | ~$4-6/mo |
| Domain or subdomain | Namecheap, Porkbun, Cloudflare Registrar | $10-15/yr |
| Cloudflare account | https://dash.cloudflare.com (free tier is fine) | $0 |
| Cloudflare API token (4 scopes) | https://dash.cloudflare.com/profile/api-tokens | $0 |
| LiveKit Cloud account | https://cloud.livekit.io (free tier: 50 users, 100 min/mo voice) | $0 to start |
| SSH keypair on your laptop | `ssh-keygen -t ed25519` if you don't have one | $0 |

Sizing notes:
- 1 vCPU / 1 GB RAM works (2 GB swap is auto-provisioned by the script).
- Backend RSS at idle ≈ 80 MB. Vite production build does NOT run on the VPS during normal operation (only during deploy).
- Bandwidth is tiny (no media transit) — KB/s, not MB/s.

---

## Pre-flight (do these BEFORE running the script)

### 1. Provision the VPS

- Ubuntu Server 24.04 LTS (or 22.04 LTS)
- SSH key uploaded at provisioner so you can `ssh root@<ip>` immediately
- Note the public IPv4

### 2. Point DNS at the VPS

If your DNS is already on Cloudflare, skip — the script will create the A record via API.

If your DNS is elsewhere, change your nameservers to Cloudflare first (one-time, takes 15 min to propagate). Cloudflare → "Add a Site" walks you through it. Don't add the A record manually; let the script do it.

### 3. Create the Cloudflare API token

https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Custom token**.

| Permission | Scope |
|---|---|
| `Zone` → `DNS` | `Edit` |
| `Zone` → `Zone Settings` | `Edit` |
| `Zone` → `SSL and Certificates` | `Edit` |
| `User` → `SSL and Certificates` | `Edit` |

Zone Resources → Include → Specific zone → `<your-apex-domain>` (e.g. `example.com`).

Click Continue → Create. Copy the token (shown only once). Paste into `CF_API_TOKEN` in the script.

The `User → SSL and Certificates → Edit` scope is the one people miss. It's required to mint an Origin Certificate via API.

### 4. Get LiveKit credentials

https://cloud.livekit.io → create project → Settings → Keys. You need three values:

- `LIVEKIT_WS_URL` — looks like `wss://your-project.livekit.cloud`
- `LIVEKIT_API_KEY` — starts with `API...`
- `LIVEKIT_API_SECRET` — long random string

(If you've been running locally, these are already in `KSCTowerNetwork-dev/backend/.env.development`. You can reuse the same project, or create a fresh one for prod — your call.)

### 5. Choose your login users

Edit the `WEB_LOGIN_USERS_JSON` in the script's CONFIG block. Format:

```json
[
  {"userId":"owner_prod",      "email":"you@example.com",      "password":"strong-password-here", "role":"owner"},
  {"userId":"buddy_prod",      "email":"buddy@example.com",    "password":"another-strong-one",   "role":"controller"},
  {"userId":"someone_else",    "email":"third@example.com",    "password":"yet-another",          "role":"pilot"}
]
```

Roles: `owner` | `controller` | `pilot`. Set `OWNER_USER_ID` to whichever userId is the owner.

These are seeded as plaintext on first boot and the backend logs a WARN until you migrate them to argon2 hashes. See "Hardening: migrate passwords" below.

### 6. SSH key on your laptop

```bash
# If you don't already have ~/.ssh/id_ed25519:
ssh-keygen -t ed25519 -C "you@laptop"
cat ~/.ssh/id_ed25519.pub
```

Copy the entire one-line output into `SSH_PUBKEY` in the script.

---

## Running the script

```bash
scp deploy/setup-vps.sh root@<vps-ip>:/root/setup-vps.sh
ssh root@<vps-ip>
nano setup-vps.sh        # edit CONFIG block at the top
bash setup-vps.sh
```

It takes 5-10 minutes on a 2 vCPU box. Output is colored by step. The script is idempotent — if it fails partway through, fix the cause and re-run.

### CONFIG fields you must change

| Field | Example | Notes |
|---|---|---|
| `DOMAIN` | `tower.example.com` | Public hostname |
| `LETSENCRYPT_EMAIL` | `you@example.com` | Even with CF, used as a contact field |
| `SSH_PUBKEY` | `ssh-ed25519 AAAA...` | Whole line from `id_ed25519.pub` |
| `CF_API_TOKEN` | `xxx...` | The token from step 3 |
| `LIVEKIT_API_KEY` | `API...` | From LiveKit dashboard |
| `LIVEKIT_API_SECRET` | `xxx...` | From LiveKit dashboard |
| `LIVEKIT_WS_URL` | `wss://your.livekit.cloud` | From LiveKit dashboard |
| `WEB_LOGIN_USERS_JSON` | see step 5 | At least one entry, not the placeholder; prefer `passwordHash` (argon2id) over plaintext `password` |
| `OWNER_USER_ID` | `owner_prod` | Must match a userId in the JSON |
| `REGISTRATION_MODE` | `invite_only` | `closed`, `invite_only`, `open`, or `open_or_invite` — public VPS should stay `invite_only` or `closed` until you intend to open signup |
| `REGISTRATION_DEFAULT_ROLE` | `pilot` | Role for self-serve signups when registration is open |

The script's `require_config` check refuses to run if any of these are still placeholders. Good — it stops you from running with `you@example.com`.

### CONFIG fields you can leave alone

| Field | Default | Change if... |
|---|---|---|
| `DEPLOY_USER` | `tower` | You want a different unix username |
| `SSH_PORT` | `22` | You want SSH on a non-standard port (cosmetic — fail2ban + key-only is the real defence) |
| `BEHIND_CLOUDFLARE` | `1` | You're not using Cloudflare (rare; you should be) |
| `INSTALL_MARIADB` | `1` | Required by the fresh-VPS production bootstrap; use server-only commands for an external database |
| `INSTALL_REDIS` | `1` | Required by the fresh-VPS production bootstrap; use server-only commands for an external cache |
| `APP_REPO_URL` | github.com/SpaceFoon/KSCTowerNetwork.git | You forked it |
| `APP_BRANCH` | `main` | You deploy from a release branch |

---

## What the script does, in order

1. `apt update && upgrade`, install base packages (`git`, `curl`, `ufw`, `fail2ban`, `unattended-upgrades`, build tools)
2. Enable `unattended-upgrades` (auto-patch security CVEs, auto-reboot at 04:30 if needed)
3. Create `tower` user, install your SSH public key, give passwordless sudo
4. Configure UFW: deny inbound by default; allow SSH; if `BEHIND_CLOUDFLARE=1`, allow 80/443 ONLY from Cloudflare's published IP ranges (anti-bypass)
5. Install the weekly `refresh-cloudflare-ips.timer` so the allowlist stays current as Cloudflare rotates ranges
6. Harden sshd: no root login, no password auth, key-only, max 3 auth tries, `AllowUsers tower` only
7. Configure fail2ban for sshd (5 fails / 10 min → 1 hr ban)
8. Create 2 GB swapfile (small VPSes OOM during `vite build` without it)
9. Install Node.js 24 LTS via NodeSource
10. Install nginx + certbot
11. **Cloudflare API automation:**
    - Verify token
    - Look up zone, autodetect VPS public IP
    - Upsert proxied A record for `$DOMAIN`
    - PATCH zone settings: SSL=strict, Always Use HTTPS, min TLS 1.2, TLS 1.3 on, WebSockets on, Authenticated Origin Pulls on, Browser Integrity Check on
    - Best-effort enable Bot Fight Mode
    - Generate RSA private key + CSR locally, POST CSR to Cloudflare → 15-year Origin Certificate
    - Download AOP CA cert
12. Install MariaDB, create DB + user with auto-generated password
13. Install Redis on 127.0.0.1:6379
14. Clone repo into `/opt/ksctower/repo`
15. `npm ci && npm run build` for both `backend` and `web`
16. Write `/etc/ksctower.env` with auto-generated `APP_JWT_SECRET` (`openssl rand -hex 32`), DB password, your CONFIG values (`TRUST_PROXY=1`, `REGISTRATION_*`, no legacy `ADMIN_USER_IDS`)
17. Install `ksctower-backend.service` systemd unit (autostart, restart on crash, capped to 5 restarts/min, V8-safe sandbox)
18. Write nginx site (TLS 1.2+, HSTS, security headers, real-IP from `CF-Connecting-IP`, `ssl_verify_client on` if AOP CA is present)
19. **Verify origin lockdown**: `curl --resolve domain:443:vps_ip` should TIMEOUT; `curl https://domain` should return 200
20. Print summary

---

## Post-deploy verification

The script's `step_verify_origin_lockdown` already runs the most important test (direct-to-IP must fail). Additional manual checks worth doing:

```bash
# Backend service is healthy
sudo systemctl status ksctower-backend
sudo journalctl -u ksctower-backend -n 50

# nginx serving correctly
sudo nginx -t
curl -I https://your-domain.com/
curl -sS https://your-domain.com/v1/health

# UFW only allows what we expect
sudo ufw status verbose

# fail2ban watching sshd
sudo fail2ban-client status sshd

# Cloudflare-only access (this should TIMEOUT, not succeed)
curl -m 8 -k --resolve your-domain.com:443:<vps-ip> https://your-domain.com/

# Same hostname via Cloudflare (this should return your SPA)
curl -I https://your-domain.com/
```

Then visit `https://your-domain.com/` in a browser, log in with one of your `WEB_LOGIN_USERS_JSON` accounts, and confirm the lobby loads.

### Fresh VPS (Linode / etc.) — operator checklist

After `bash setup-vps.sh` finishes, **before** closing the root SSH session:

1. Open a **second** terminal and confirm deploy-user SSH: `ssh -p 22 tower@<your-domain>` (or your `SSH_PORT`).
2. On the VPS, verify the backend refuses to run without MariaDB/Redis: with `NODE_ENV=production`, a broken `REDIS_URL` or DB credentials should crash at boot (fail-fast); fix env and `systemctl restart ksctower-backend`.
3. Run the checks in the shell block above plus `curl -sS https://your-domain.com/v1/health`.
4. Log in as owner in the browser, call `/v1/auth/me` (or use devtools Network after login), confirm role `owner`.
5. Confirm **origin lockdown**: direct `curl --resolve` to the VPS IP must **not** succeed for your public hostname when `BEHIND_CLOUDFLARE=1`.

---

## Distributing the mod to your buddy

The web side is now public, but the buddy needs the KSP plugin (and bridge runtime) if they're going to fly from their own KSP. If they're only going to be a tower controller in the browser, they need nothing — just the URL and login.

### Pilot side (anyone running KSP)

1. On your Windows machine, edit two C# files:
   - `KSCTowerNetwork-dev/PluginSrc/TowerToolbar.cs`
   - `KSCTowerNetwork-dev/PluginSrc/TowerTelemetryPublisher.cs`

   Change:
   ```csharp
   private const string ApiBaseUrl = "http://127.0.0.1:8787/v1";
   ```
   To:
   ```csharp
   private const string ApiBaseUrl = "https://your-domain.com/v1";
   ```

2. Rebuild:
   ```powershell
   .\KSCTowerNetwork-dev\build-plugin.ps1
   ```

3. The recommended distribution path is the existing release packager. From `KSCTowerNetwork-voice-bridge/voice-bridge/`:
   ```powershell
   # Edit GameData/KSCTowerNetwork/release-config.json:
   #   web.origin     = "https://your-domain.com"
   #   backend.origin = "https://your-domain.com"
   #   sessionId      = "tower-public"   (or whatever)
   # Web SPA is built from KSCTowerNetwork-dev/web when that folder exists next to
   # your KSP root (no need to copy web/ into GameData). Override with -WebSourcePath if needed.
   powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
   ```
   Output: `release/KSCTowerNetwork-<version>.zip`. That's the file your buddy downloads. Inside is a single `GameData/KSCTowerNetwork/` they drop into their KSP install.

4. They launch KSP, the bridge auto-starts (watch Task Manager for `node.exe`), they open `https://your-domain.com/` in a browser, log in with the credentials you gave them, hit PTT.

### Tower-only side (browser only, no KSP)

Just give them the URL and credentials. Done.

---

## Maintenance

### Redeploy after a `git push`

```bash
ssh tower@your-domain.com
sudo -u tower git -C /opt/ksctower/repo pull
sudo -u tower bash -lc "cd /opt/ksctower/repo/KSCTowerNetwork-dev/backend && npm ci && npm run build"
sudo -u tower bash -lc "cd /opt/ksctower/repo/KSCTowerNetwork-dev/web && VITE_API_BASE='' npm ci && npm run build"
sudo systemctl restart ksctower-backend
```

(If you redeploy often, ask me to drop a `redeploy.sh` next to `setup-vps.sh`.)

### Re-run the setup script

It's idempotent. Safe scenarios to re-run:

- You changed `WEB_LOGIN_USERS_JSON` in the CONFIG block → re-run, it rewrites `/etc/ksctower.env` and restarts the service
- You changed Cloudflare settings (e.g. WebSockets toggled off accidentally) → re-run, the API calls re-apply
- You upgraded Node.js to a new major and want to bump the VPS → re-run after editing `step_node`

It does NOT re-issue the Origin Cert if `/etc/ssl/cloudflare/origin.{crt,key}` already exist. To force a fresh cert, delete those files first.

### Logs

```bash
# Backend (live)
sudo journalctl -u ksctower-backend -f

# Backend (last hour)
sudo journalctl -u ksctower-backend --since "1 hour ago"

# nginx access + error
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# UFW (denied connections — should be near-empty if CF lockdown works)
sudo grep 'UFW BLOCK' /var/log/ufw.log

# fail2ban actions
sudo fail2ban-client status sshd
sudo journalctl -u fail2ban -f

# unattended-upgrades history
cat /var/log/unattended-upgrades/unattended-upgrades.log
```

### Backups

The script does NOT configure backups. Minimum viable: run a nightly mysqldump cron + sync to off-VPS storage (S3, B2, another VPS).

```bash
# Quick & dirty: paste this into /etc/cron.daily/ksctower-backup, chmod 755
#!/usr/bin/env bash
set -euo pipefail
ts="$(date +%Y%m%d-%H%M%S)"
out="/var/backups/ksctower"
mkdir -p "$out"
mysqldump --single-transaction ksc_tower | gzip > "$out/db-$ts.sql.gz"
find "$out" -name 'db-*.sql.gz' -mtime +14 -delete
# TODO: rsync $out to off-box storage
```

---

## Hardening: things to do AFTER first deploy works

### Migrate passwords from plaintext to argon2id

The backend logs a WARN on every boot until you do this:

```
WARN: WEB_LOGIN_USERS_JSON entry uses plaintext 'password'; migrate to 'passwordHash'
```

For each user, generate a hash:

```bash
node -e "import('argon2').then(a => a.hash('THE_PASSWORD', {type: a.argon2id}).then(console.log))"
```

Copy the resulting `$argon2id$...` string. In `/etc/ksctower.env`, replace the entry:

```diff
- {"userId":"buddy_prod","email":"buddy@example.com","password":"raw-password","role":"controller"}
+ {"userId":"buddy_prod","email":"buddy@example.com","passwordHash":"$argon2id$v=19$m=...","role":"controller"}
```

Then `sudo systemctl restart ksctower-backend`.

### Enable Cloudflare's free WAF Managed Rules

The script enables Bot Fight Mode but doesn't touch the WAF Managed Rules (because those need an interactive accept on the dashboard for the Cloudflare Free plan). One-time click:

Cloudflare dashboard → Security → WAF → Managed Rules → enable **Cloudflare Managed Ruleset** (free).

### Consider Clerk for auth

The shipped auth (hardcoded user list in env) is fine for a small private group. For anything larger, swap to Clerk:

- `npm install @clerk/clerk-react` in `web/`
- Wrap `<App>` in `<ClerkProvider>` in `web/src/main.tsx`
- Replace `LoginPage.tsx` form with Clerk's `<SignIn>`
- Set `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` in `/etc/ksctower.env`
- `sudo systemctl restart ksctower-backend`

The backend's `verifyToken` middleware already supports Clerk session tokens. No backend code change needed.

---

## Security model — what's actually protecting you

| Threat | Defence |
|---|---|
| SSH brute-force | Key-only auth, fail2ban (5/10min → 1h ban), `AllowUsers tower` only, no root login |
| OS CVE published tomorrow | unattended-upgrades polls daily, auto-reboots if needed |
| Volumetric DDoS | Cloudflare absorbs it |
| L7 / app exploit, generic bot scanners | Cloudflare WAF + Bot Fight Mode |
| Origin IP discovered (CT logs, Shodan, historical DNS) → CF bypass | UFW only allows 80/443 from Cloudflare's published ranges; weekly refresh timer keeps the list current |
| Cloudflare bypass via spoofed source IP that happens to be in CF range | Authenticated Origin Pulls — nginx requires CF's client cert; without it, connection refused |
| Spoofed `X-Forwarded-For` for ban evasion | nginx uses `CF-Connecting-IP` (only trusted from CF ranges); backend trusts only one proxy hop (`TRUST_PROXY=1`) |
| Stolen Origin Cert mounted on attacker IP | Pointless — CF Full(strict) won't connect to a foreign IP, and even if you bypass CF, AOP fails |
| Bad app config crash-loop pounding the box | systemd `StartLimitBurst=5` |
| Process escape / privilege escalation | systemd sandbox: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, syscall filter (`@system-service` minus `@privileged @resources`), `LockPersonality`, `RestrictNamespaces`, `RestrictRealtime` |
| App-level abuse: login spam, rate-limit evasion | Backend's `express-rate-limit` keyed on real client IPs (works because `TRUST_PROXY=1` + nginx real_ip) |
| Database access from the internet | MariaDB binds 127.0.0.1 only, never reachable from outside |

What this setup does NOT defend against:

- **A malicious owner/admin account.** Anyone with the owner credentials can do anything. Pick a strong password and migrate it to argon2.
- **Bugs in the application code.** The `SECURITY_HARDENING.md` audit covers what the code does about this.
- **You losing the SSH key** with no recovery. Most VPS providers give you a serial console fallback — know how to use it.
- **Cloudflare itself getting compromised.** If that happens we have bigger problems.

---

## Troubleshooting

### `bash setup-vps.sh` exits at `require_config`

You left a placeholder in the CONFIG block. The error tells you which field. Fix and re-run.

### `CF API token verification failed`

Your token is missing one of the four required scopes. Most common: `User → SSL and Certificates → Edit` is missing (it's the only User-scoped one and easy to forget).

### `Origin Cert API call failed`

Same as above — User-scoped SSL & Certificates Edit is required to mint Origin Certs.

### `Failed to fetch Cloudflare IP ranges`

Your VPS can't reach `https://www.cloudflare.com/ips-v4` at provisioning time. Check outbound DNS / firewall on the VPS provider side.

### `step_verify_origin_lockdown`: BYPASS POSSIBLE

UFW didn't apply the Cloudflare-only rules. Run `sudo ufw status verbose`. Common cause: `BEHIND_CLOUDFLARE=0` was left from a previous test run. Fix the CONFIG, re-run.

### Buddy can't log in (web returns 401)

- Wrong password (case-sensitive, no whitespace)
- The user isn't in `WEB_LOGIN_USERS_JSON` in `/etc/ksctower.env` — check with `sudo cat /etc/ksctower.env | grep WEB_LOGIN`
- CORS rejection — check `sudo journalctl -u ksctower-backend -n 100 | grep CORS`. `CORS_ORIGINS` must equal `https://your-domain.com` exactly.

### Voice doesn't work for buddy

Voice goes browser ↔ LiveKit Cloud, not through your VPS. Check:
- LiveKit credentials in `/etc/ksctower.env` are correct (test by reading the backend's `LIVEKIT_*` env values + the LiveKit dashboard)
- Cloudflare's WebSockets setting is ON (the script sets it; confirm in the dashboard if voice fails)
- Buddy's browser allowed mic access on the page

### `npm ci` fails during `step_build` with EACCES or out-of-memory

Out-of-memory: the swap step should have prevented this; check `free -h`. If you skipped or removed swap, add it manually.

EACCES: the script ran the install as `tower` user against `/opt/ksctower/repo`. Check ownership: `sudo ls -la /opt/ksctower/`. Should be `tower:tower`.

### Backend won't start, journalctl shows `MemoryDenyWriteExecute`

You're running an old version of the script. The current version omits that directive (it breaks Node V8 JIT). Pull the latest `setup-vps.sh` and re-run.

### `apt-get install -y nodejs` fails

The NodeSource setup script may have changed format. Update `step_node` to use the current setup URL from https://github.com/nodesource/distributions.

### Plugin can't reach the backend after rebuild

The `ApiBaseUrl` constant in `TowerToolbar.cs` and `TowerTelemetryPublisher.cs` is hardcoded into the DLL at compile time. If you changed it but didn't rebuild, it still points at localhost. Re-run `build-plugin.ps1` and redistribute the DLL.

---

## Cost estimate

Monthly, for a small private group:

| Item | Cost |
|---|---|
| VPS (Hetzner CX22, 2 vCPU / 4 GB) | ~€4.50 |
| Domain | ~$1 |
| Cloudflare (Free plan) | $0 |
| LiveKit Cloud (Build plan, 50 users) | $0 up to 100 min/mo of voice, $0.005/min beyond |

So ~$6/mo plus voice usage. A 4-hour session with 4 people talking is 16 person-hours = 960 person-minutes ≈ $4.80 at LiveKit's metered rate. If you're doing more than a few sessions a month, look at LiveKit's $50/mo Ship plan.

---

## Files referenced by this guide

| File | Purpose |
|---|---|
| `deploy/setup-vps.sh` | The actual provisioning script |
| `deploy/README.md` | This document |
| `HOSTING.md` | Older / shorter manual deployment notes (`release-config.json` based player release packaging) |
| `PRODUCTION_DEPLOYMENT_PLAN.md` | Original planning doc; superseded by this guide for VPS deployment |
| `SECURITY_HARDENING.md` | Application-level security audit |
| `KSCTowerNetwork-dev/backend/.env.development` | Local dev env (do NOT copy to production) |
| `GameData/KSCTowerNetwork/release-config.example.json` | Player-release packaging template |
| `KSCTowerNetwork-dev/build-plugin.ps1` | Builds the KSP plugin DLL on Windows |
| `KSCTowerNetwork-voice-bridge/voice-bridge/scripts/package-release.ps1` | Packages the player ZIP with hostnames baked in |
