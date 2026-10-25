# Server hosting: Linux VPS and Windows

This guide takes an operator from a source checkout to an HTTPS website, an owner login, and a server that survives logout/reboot. The server runs **backend + web**, with **MariaDB + Redis** and **LiveKit**. It does not run KSP or the player's voice bridge.

## Installing the prebuilt server release

Download the Server ZIP from the same GitHub Release as your pilots' Client ZIP.
Extract into a fresh directory. From KSCTowerNetwork-dev run:

```bash
bash deploy/server.sh install
```

On Windows use `powershell -File deploy/server.ps1 install`. This installs only
production backend dependencies for the host OS and creates backend/.env.production
if missing. Configure it using step 4 below. The backend and same-origin web/dist
are already built: skip source checkout/setup/build steps. Follow the database,
proxy, service and first-login instructions below; adjust paths to your extraction
directory. Node, MariaDB, Redis, HTTPS and LiveKit remain external prerequisites.
The archive includes no real credentials or initial owner account. A fresh owner
password hash must be configured before login. Preserve private config/data on updates.

## Choose a setup

- **Fresh Ubuntu VPS:** the [Ubuntu bootstrap guide](../deploy/README.md) installs OS packages, database/cache, nginx, TLS, and systemd. It also changes SSH/firewall and can configure Cloudflare. Follow that guide if you want that full provisioning process.
- **Existing Linux VPS:** follow the manual recipe below. It uses Caddy directly on the public hostname; Cloudflare is optional and not assumed.
- **Windows host:** use the PowerShell commands at the end, with the same production configuration and external database/cache/HTTPS requirements.

Do not mix the nginx bootstrap and the manual Caddy recipe on the same ports. The Bash/PowerShell `server` scripts install app dependencies and build/start the backend; they do not install Node, databases, a web proxy, DNS or TLS.

## 1. Prepare the Linux host

You need an administrator account with sudo, a domain such as `tower.example.com`, and a DNS A record pointing at the VPS. Add an AAAA record only if IPv6 actually reaches this machine. Allow TCP 80/443 in the provider firewall for direct Caddy HTTPS. Keep SSH access and leave backend port 48787, MariaDB 3306 and Redis 6379 closed to the public internet.

Install **Node 24.22.1 LTS with npm** systemwide using the [official Node downloads](https://nodejs.org/en/download). It must be available to the service account, not only through the administrator's shell profile. Install Caddy using its [official Debian/Ubuntu instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

From your administrator shell, on Ubuntu:

```bash
sudo apt update
sudo apt install -y git build-essential python3 mariadb-server redis-server openssl
sudo systemctl enable --now mariadb redis-server
id tower >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash tower
sudo install -d -o tower -g tower /opt/ksctower
sudo -u tower -H node --version
sudo -u tower -H npm --version
```

Both version commands must succeed. Native backend dependencies may need the listed build tools if a prebuilt binary is unavailable. If your database/cache are external, provision them privately and use their real connection settings instead of the local examples below. Both must be reachable: production startup refuses an unavailable MariaDB or Redis.

## 2. Get the source and install server dependencies

Still in your administrator shell:

```bash
sudo -u tower -H git clone https://github.com/SpaceFoon/KSCTowerNetwork.git /opt/ksctower/KSCTowerNetwork
sudo -iu tower
cd /opt/ksctower/KSCTowerNetwork/KSCTowerNetwork-dev
bash deploy/server.sh setup
```

You are now in the **tower account's shell**. Keep this shell for app configuration/build commands. Setup installs only backend and web packages. It creates `backend/.env.production` from [server.env.example](../deploy/server.env.example) if missing; it never overwrites an existing env file. It does not install the root developer workspace, voice bridge, portable Windows Node, or game plugin.

## 3. Create the database

In a separate **administrator terminal**, run `sudo mariadb`. Execute the following SQL, replacing the password with your own value:

```sql
CREATE DATABASE ksc_tower CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ksc_tower'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_DATABASE_PASSWORD';
GRANT ALL PRIVILEGES ON ksc_tower.* TO 'ksc_tower'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Use this same password in `MARIADB_PASSWORD`. The app creates/migrates its schema at startup. If MariaDB reports the client as `ksc_tower@localhost`, create/grant that local account too with the same password; do not replace it with a publicly accessible root account. A managed database may require its own administrator to create the database/user and grant schema privileges.

Redis must be reachable at the configured `REDIS_URL`. The local example uses `redis://127.0.0.1:6379`; use your provider's private URL/password/TLS requirements for managed Redis.

## 4. Configure secrets, owner login and voice

In the **tower shell**, from `KSCTowerNetwork-dev`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy that value into `APP_JWT_SECRET`. Keep it stable across updates; changing it invalidates existing app-issued tokens.

Generate the owner's password hash. The command asks for the password interactively rather than putting it in command-line history:

```bash
cd backend
node -e "const rl=require('node:readline/promises').createInterface({input:process.stdin,output:process.stdout});rl.question('Owner password: ').then(p=>require('argon2').hash(p,{type:require('argon2').argon2id})).then(h=>{console.log(h);rl.close()}).catch(e=>{console.error(e.message);rl.close();process.exitCode=1})"
cd ..
```

Edit `backend/.env.production`. Fill in these values; retain the other settings from the template:

```dotenv
NODE_ENV=production
APP_JWT_SECRET=PASTE_GENERATED_RANDOM_SECRET
OWNER_USER_ID=owner_prod
WEB_LOGIN_USERS_JSON='[{"userId":"owner_prod","email":"you@example.com","passwordHash":"PASTE_COMPLETE_ARGON2ID_HASH","role":"owner"}]'
CORS_ORIGINS=https://tower.example.com
TRUST_PROXY=1
REGISTRATION_MODE=invite_only
REGISTRATION_DEFAULT_ROLE=pilot
LIVEKIT_API_KEY=YOUR_LIVEKIT_API_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_API_SECRET
LIVEKIT_WS_URL=wss://YOUR_LIVEKIT_PROJECT.livekit.cloud
MARIADB_HOST=127.0.0.1
MARIADB_PORT=3306
MARIADB_USER=ksc_tower
MARIADB_PASSWORD=YOUR_DATABASE_PASSWORD
MARIADB_DATABASE=ksc_tower
REDIS_URL=redis://127.0.0.1:6379
DEV_OPEN_AUTH=false
DEV_DEFAULT_WEB_USER=false
DEV_IN_MEMORY=false
```

Replace the email, hostname and every placeholder. Keep the owner JSON on **one line**, with its outer single quotes; preserve the complete hash, including every `$`. `OWNER_USER_ID` must match that entry's `userId`. An empty `WEB_LOGIN_USERS_JSON=[]` supplies no initial owner login. There is no production default password.

Create a LiveKit project at [LiveKit Cloud](https://cloud.livekit.io/) and copy its API key, secret and WebSocket URL into the server env. A separately operated LiveKit deployment can supply the same settings. Backend keys stay on the server; browsers receive scoped session tokens. App login/telemetry do not establish that voice works—check voice separately after login.

For the single Caddy proxy in this recipe, `TRUST_PROXY=1` and the exact HTTPS origin are appropriate. If you add Cloudflare or another proxy, use the bootstrap's corresponding configuration or deliberately adjust the trust topology; do not blindly reuse this setting.

```bash
chmod 600 backend/.env.production
```

The server launcher loads this file explicitly; running `node dist/index.js` directly does **not** automatically load `.env.production`. systemd uses `EnvironmentFile` in the next step. Real env files are gitignored; do not commit them.

## 5. Build and check the backend

In the **tower shell**:

```bash
bash deploy/server.sh build
bash deploy/server.sh start
```

Build produces `backend/dist/` and `web/dist/`. Start runs the production backend in the foreground. In another terminal:

```bash
curl --fail http://127.0.0.1:48787/v1/health
```

Expect JSON with `"ok":true` and `"service":"ksc-tower-backend"`. Startup must report successful MariaDB and Redis connections. If it refuses to start, resolve the reported configuration/connection issue; do not enable development auth or in-memory flags on the public server.

Stop the foreground process with Ctrl+C before installing its supervised service. A foreground process alone is not unattended hosting. If you use another private env file, start with `bash deploy/server.sh start --env-file /etc/ksctower.env`.

The web build defaults to same-origin `/v1`. A separate API hostname requires `VITE_API_BASE` exported **before** build and corresponding backend CORS; this guide uses one hostname to avoid that extra configuration.

## 6. Keep the backend running with systemd

Return to your **administrator shell** (`exit` from the tower shell). Copy the provided service:

```bash
sudo cp /opt/ksctower/KSCTowerNetwork/KSCTowerNetwork-dev/deploy/ksctower-backend.service.example /etc/systemd/system/ksctower-backend.service
command -v node
sudo nano /etc/systemd/system/ksctower-backend.service
```

Set `ExecStart` to the actual absolute Node executable path printed above; the example uses `/usr/bin/node`. Check the `User`, `Group`, `WorkingDirectory` and `EnvironmentFile` paths if you chose different account/install locations. The tower user must own its backend runtime/data directory and be able to read its env file.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ksctower-backend
sudo systemctl status ksctower-backend --no-pager
sudo journalctl -u ksctower-backend -n 50 --no-pager
```

The service should be active. It restarts on failure and starts after reboot; investigate repeated restarts in the journal.

## 7. Serve the web app with HTTPS

Use the included [Caddy example](../deploy/Caddyfile.example). In your **administrator shell**:

```bash
sudo cp /opt/ksctower/KSCTowerNetwork/KSCTowerNetwork-dev/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Replace `tower.example.com` with your hostname and confirm the static root points at your `web/dist` folder. The caddy account needs read/traverse permission on that path. This configuration serves real files, falls back to `index.html` for browser routes, and proxies `/v1` API/WebSocket requests without stripping their path. [Caddy reverse-proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) preserves upgrade handling and supplies forwarded headers; [try_files](https://caddyserver.com/docs/caddyfile/directives/try_files) provides the SPA fallback.

For direct-origin Caddy HTTPS, DNS and inbound TCP 80/443 must reach this VPS so certificate issuance can succeed. Production session cookies require HTTPS. The backend listens behind the proxy; protect 48787 with the firewall. No Windows or player software is installed by this recipe.

Do not open **48788/UDP** on a public production host. The UDP listener is disabled by default, binds to loopback, and accepts only empty-token local-development traffic. Authenticated plugin telemetry uses HTTPS. LiveKit may need its own network setup if you self-host it; that is a separate service from this app.

## 8. First login and first users

1. Open your HTTPS website and sign in with the email/password from the owner entry.
2. Open **Owner** (`/owner`) and its **Invite codes** section. Create an invite for your users.
3. A new user registers through the login page with an invite. Invite-only registration gives them the configured default role, normally `pilot`.
4. Use the owner's role controls to grant `controller` when needed. `/admin` is the moderation console; `/owner` contains owner-only controls.
5. Controllers use **Take next call** in the Lobby. Tower/Wall views require an active assigned/joined room; their absence before joining is expected.
6. Test voice with another participant and grant microphone permission in the browser. Then verify a separately installed pilot client can pair and send telemetry. A healthy web/API response is not proof of voice or KSP integration.

For optional charts, use the authenticated **Charts** link and follow [download/install instructions](AEROCHART_REFERENCE.md). Install chart files after building the web app; a rebuild replaces `web/dist`.

## 9. Verify, update and preserve data

From outside the VPS:

```bash
curl --fail https://tower.example.com/v1/health
```

Check login, a direct link such as `/owner` after refresh, invite registration, role controls, voice and pilot telemetry. DNS/TLS, service restart and actual client integration need these live checks before announcing a functioning public service.

Before updating, back up **MariaDB**, the private env file/JWT secret, and `backend/data/` (registered-user, invite and other local stores). Keep backups private. Retain the optional chart folder if installed. Do not replace these with files from a fresh clone or assume all user state lives in MariaDB.

For this manual recipe, from your administrator shell during a maintenance window:

```bash
sudo systemctl stop ksctower-backend
sudo -u tower -H git -C /opt/ksctower/KSCTowerNetwork pull --ff-only
sudo -u tower -H bash -c 'cd /opt/ksctower/KSCTowerNetwork/KSCTowerNetwork-dev && bash deploy/server.sh setup && bash deploy/server.sh build'
# Restore/install optional charts into web/dist/charts if used.
sudo systemctl start ksctower-backend
curl --fail https://tower.example.com/v1/health
```

If install/build fails, investigate before restarting with mixed outputs. The Ubuntu bootstrap uses its own installation paths, so use its documented redeploy commands instead.

## Common failures

| Symptom | Check |
| --- | --- |
| MariaDB/Redis startup refusal | Services running, database/user created, password and network settings correct |
| Owner login rejected | Valid one-line JSON, complete passwordHash, exact email, explicit `owner` role and matching OWNER_USER_ID; restart after env changes |
| HTTPS website returns 502 | Backend service status/logs and proxy destination port |
| Website returns 403 or blank page | Static-root path and caddy account read/traverse permissions; browser console/network |
| Direct `/owner` or `/charts` refresh returns 404 | SPA fallback in the proxy configuration |
| Login immediately disappears or mutations fail | HTTPS, CORS origin, forwarded scheme and correct trust-proxy topology |
| Voice does not connect | LiveKit URL/key/secret, participants in a room, browser mic permission and LiveKit network connectivity |
| Charts unavailable after update | Restore/reinstall the generated chart folder after the web build |
| Works until SSH closes | Run the backend under systemd, not only a foreground terminal |

See [Troubleshooting](TROUBLESHOOTING.md) and [Settings reference](SETTINGS_REFERENCE.md) for deeper diagnostics.

## Windows server commands

Install Node 24.22.1 LTS with npm, and make MariaDB/Redis reachable. From `KSCTowerNetwork-dev`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 setup
# Configure backend/.env.production using step 4 above; generate the owner hash from backend.
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 start
# Another env file: ... start -EnvFile "C:/Private/server.env"
```

Use IIS/nginx/Caddy for static `web/dist`, SPA fallback, HTTPS and the API/WebSocket proxy. The Linux systemd recipe does not apply on Windows: configure your chosen Windows service supervisor to run Node's backend entry with the private production environment and the backend working directory. The PowerShell wrapper runs in the foreground and does not register a Windows service. An unattended Windows-service recipe has not been validated here.

## Verification limits

The shared launcher, backend compilation and web production/typecheck build were checked on Windows/Git Bash. Production startup guards and env parsing tests passed. Production Charts routing was browser-checked with a mocked signed-in account; this does not prove real authentication, LiveKit or KSP integration. Native VPS provisioning, real database/cache startup, TLS certificates, reboot/restart behavior and the manual service/proxy recipe still require a live Linux deployment check.
