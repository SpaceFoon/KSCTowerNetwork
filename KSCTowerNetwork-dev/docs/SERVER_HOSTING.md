# Server hosting on a VPS or Windows host

The operator's server runs the Node backend and static web app. It needs no KSP install, plugin compiler, player voice bridge, or Windows runtime. Voice is handled by LiveKit Cloud or a separate self-hosted LiveKit service.

## Existing Linux VPS

Install Node 22+ with npm (Node 24 recommended), MariaDB and Redis, and nginx or Caddy. Clone the public source repo:

```bash
git clone https://github.com/SpaceFoon/KSCTowerNetwork.git
cd KSCTowerNetwork/KSCTowerNetwork-dev
bash deploy/server.sh setup
# Edit backend/.env.production: JWT secret, owner login/passwordHash,
# exact HTTPS web origin, LiveKit keys and database credentials.
bash deploy/server.sh build
bash deploy/server.sh start
```

Setup installs **only backend and web dependencies**, and creates a production env template only if absent. It skips the root development bootstrap and all player-side tools. Build emits `backend/dist` and `web/dist`; no optional charts are included in a clean checkout. Start runs the backend in production in the foreground. Ctrl+C stops it. It refuses the unchanged JWT placeholder. Existing backend production guards still reject development auth/bypass flags. For another private env file, use `bash deploy/server.sh start --env-file /etc/ksctower.env`.

Run the backend through systemd for restart/autostart; set WorkingDirectory to the backend directory, EnvironmentFile to the private production env, and ExecStart to `/usr/bin/node dist/index.js`. The existing Ubuntu bootstrap generates this service automatically.

Serve `web/dist` with nginx/Caddy and SPA fallback to `index.html`. Proxy `/v1/` and its WebSocket upgrade to `127.0.0.1:48787`, preserving Authorization, cookies and forwarded HTTPS headers. Enable TLS for the public hostname: production session cookies require HTTPS. Match CORS_ORIGINS to that HTTPS origin and TRUST_PROXY to the real proxy topology. Keep the backend port behind the proxy/firewall. Optional live UDP uses port 48788; permit it explicitly if needed, or use the documented HTTP fallback. Database and Redis credentials belong in the private server env. See [deployment](DEPLOYMENT.md) for details.

By default the web build uses same-origin `/v1`. For a separate API hostname, export `VITE_API_BASE=https://api.example.com` before building and configure backend CORS accordingly. Charts, if wanted, are installed after the web build with the separate chart installer.

## Fresh Ubuntu VPS

The existing [Ubuntu bootstrap](../deploy/setup-vps.sh) installs Node, nginx, MariaDB/Redis, generates deployment secrets, configures TLS and a systemd service, and builds backend/web. Its defaults now use `SpaceFoon/KSCTowerNetwork` on `main`. Configure a private copy as described in the [VPS guide](../deploy/README.md), then run it on the VPS. It also changes SSH/firewall and Cloudflare settings; review those inputs before running. We have not deployed it to a real VPS during this change.

## Windows server

With Node 22+ and npm, from `KSCTowerNetwork-dev`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 setup
# Configure backend/.env.production.
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/server.ps1 start
# Or: ... start -EnvFile "C:/Private/server.env"
```

Use IIS/nginx/Caddy for the static site and HTTPS API proxy, with MariaDB/Redis available locally or externally. Install the backend as a supervised service for unattended hosting. These commands do not configure the operating system or provision LiveKit. The Bash and PowerShell wrappers share `deploy/server.mjs` so setup/build/start behave the same.

## Verification for these entry points

Backend compilation and the web production build (including TypeScript checking) passed through the Bash server wrapper on Windows/Git Bash. The PowerShell wrapper invoked the production backend and correctly rejected a development-auth bypass. Two private-env parsing/validation tests passed. Bash syntax checks passed for both the server wrapper and Ubuntu bootstrap. Native Linux VPS provisioning, live database/cache startup, TLS and unattended-service operation were not exercised in this change.
