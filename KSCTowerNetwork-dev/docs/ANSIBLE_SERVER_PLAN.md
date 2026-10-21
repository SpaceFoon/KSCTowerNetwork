# Ansible plan — server-side infrastructure (KSC Tower Network)

This document is a **planning-only** blueprint for managing **operator-facing server infrastructure** with Ansible: OS baseline, data stores, Node backend, reverse proxy/TLS, static web (optional), firewall, and secrets. It does **not** assume any playbooks or roles exist yet in the repo.

**Related docs:** [DEPLOYMENT.md](DEPLOYMENT.md), [PRODUCTION_DEPLOYMENT_PLAN.md](PRODUCTION_DEPLOYMENT_PLAN.md), [HOSTING.md](HOSTING.md), [ARCHITECTURE.md → Ports, firewall, and live transport](ARCHITECTURE.md#ports-firewall-and-live-transport), [VOICE_BRIDGE.md](VOICE_BRIDGE.md).

---

## 1. Purpose and scope

### In scope (Ansible)

- **Compute**: Linux VPS (or similar) hardened for running the **Express/TypeScript backend** from `KSCTowerNetwork-dev/backend/`.
- **Data**: **MariaDB** and **Redis** (on the same host, or separate hosts, or replaced by managed services via connection strings only).
- **Edge**: **TLS termination** and reverse proxy (**nginx** or **Caddy**); WebSocket proxying for live browser transport.
- **Network**: Host firewall rules aligned with [ARCHITECTURE.md](ARCHITECTURE.md) (public HTTPS API; no public UDP telemetry port).
- **Process supervision**: **systemd** units for the backend (restart policies, logging to journald).
- **Static web (optional)**: Build `KSCTowerNetwork-dev/web/` with Vite and serve `dist/` from the same proxy or a dedicated static host (Ansible can own the nginx `root` + SPA fallback pattern).

### Out of scope (do not fold into the same “API server” playbook without a deliberate design)

- **KSP plugin** and **GameData** hygiene — use existing Windows-oriented scripts (e.g. `build-plugin.ps1`); not part of server Ansible unless you add a separate “mod release” automation story.
- **Voice bridge** — normally runs on the **pilot PC** next to KSP; see [§10](#10-voice-bridge-separate-footprint). Optional headless bridge hosts are a **different** inventory group and role set.
- **LiveKit Cloud** and **Clerk** — third-party; Ansible only stores **references** (URLs) and **secrets** (keys), not their control plane.
- **CI** — optional; Ansible can either build on the target (`npm ci` + `npm run build`) or deploy a **prebuilt artifact** from CI. Pick one strategy per environment.

---

## 2. Architecture recap (what Ansible must line up)

End-state topology (operator infra):

```
[Pilot PC]                         [Operator VPS / cloud]
KSP + plugin ──HTTPS /v1────────► Node backend (:PORT behind proxy)
       │                              ├── MariaDB
       │                              └── Redis
Voice bridge (local) ──wss──────► LiveKit Cloud ◄── Tower browser (HTTPS)
```

The optional UDP listener is local-development only, disabled by default, and
must not be exposed on the public host firewall.

**URL consistency** (from [DEPLOYMENT.md](DEPLOYMENT.md)):

- Plugin → backend public base URL.
- Plugin / login GUI → web SPA public origin (`webBaseUrl`).
- Backend **`CORS_ORIGINS`** → exact browser origin(s) of the SPA.
- LiveKit URLs → from LiveKit project; backend issues tokens.

---

## 3. Target OS and sizing assumptions

| Decision | Recommendation |
|----------|------------------|
| OS | **Ubuntu Server LTS** or **Debian stable** (Ansible support is strongest; match what your VPS provides). |
| Node | **Active LTS** matching backend tooling (`package.json` uses modern Node; pin major version in role variables). |
| User | Dedicated unprivileged **`tower`** (or `ksc-tower`) user; backend runs as this user, not `root`. |
| Paths (example) | `/opt/ksc-tower/backend` application tree; `/etc/ksc-tower/backend.env` environment file; `/var/log/ksc-tower/` if you add file logs (optional; journald is enough). |

Sizing is workload-dependent; see [PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md) for hot paths. Ansible should not encode fixed CPU/RAM; document **minimum** in README for operators.

---

## 4. Suggested repository layout (future)

When you add Ansible to the monorepo (or a small side repo), a clean layout:

```
KSCTowerNetwork-dev/
  ansible/
    ansible.cfg
    inventories/
      production/
        hosts.yml
      staging/
        hosts.yml
    group_vars/
      tower_api.yml
      tower_db.yml          # optional separate DB group
    host_vars/
      prod-api-01.yml
    roles/
      common/
      firewall/
      nodejs/
      mariadb/
      redis/
      nginx/                 # or caddy/
      ksc_backend/
      ksc_web/               # optional
    playbooks/
      site.yml               # full stack on one box
      db.yml                   # only MariaDB + Redis
      app.yml                  # deploy backend + reload systemd
    README.md
```

Keep **Vault** files next to the groups they encrypt (e.g. `group_vars/tower_api/vault.yml`) and document how to edit them (`ansible-vault edit`).

---

## 5. Inventory design

### Groups

| Group | Purpose |
|-------|---------|
| `tower_api` | Hosts running Node backend + (usually) nginx. |
| `tower_db` | Optional: hosts running only MariaDB/Redis if split from API. |
| `tower_web` | Optional: static file only host; often same as `tower_api`. |
| `tower_bridge` | **Optional** — only if you run headless voice bridge on a server; see [§10](#10-voice-bridge-separate-footprint). |

### Host variables (per host)

Examples of what belongs in `host_vars/`:

- Public **`api_hostname`** (e.g. `api.tower.example.com`).
- Public **`web_hostname`** if SPA is same machine (e.g. `tower.example.com`) or different.
- Public UDP exposure is disabled; authenticated plugin telemetry uses HTTPS.
- **`backend_listen`**: typically `127.0.0.1:PORT` when nginx is on-box (backend not exposed except via proxy).

---

## 6. Group variables (non-secret defaults)

Place **non-sensitive** defaults in `group_vars/tower_api.yml`:

- `NODE_ENV=production`
- `PORT` (default in code: **48787** — may stay internal if nginx fronts 443)
- `LIVE_UDP_ENABLED`, `LIVE_UDP_HOST`, `LIVE_UDP_PORT` (defaults **false**, **127.0.0.1**, **48788**) — local development only; keep disabled in production
- `TRUST_PROXY` — **must** match proxy topology (see `backend/src/config/env.ts` comments: too much trust breaks IP bans / rate limits; too little collapses clients to one IP)
- Telemetry and idle-sweep tuning (`TELEMETRY_*`, `PILOT_IDLE_*`) if you want environment-specific values
- Paths: install root, env file path, systemd unit names

**Never** put real secrets in plain `group_vars`; use Vault.

---

## 7. Secrets and Ansible Vault

### Must be vaulted (examples)

- `APP_JWT_SECRET` (long random; not dev default)
- `MARIADB_PASSWORD` (and root password if role sets it)
- `REDIS_URL` if it includes credentials (`redis://:password@host:6379`)
- `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` (if using Clerk)
- `LIVEKIT_API_SECRET`, and optionally keys if not using public read-only values
- `WEB_LOGIN_USERS_JSON` **if** you inject password-bearing JSON via env (consider operational rotation policy)
- Any `DEV_BEARER_SECRET` — **only** non-production inventories

### Production guardrails (backend)

The backend **refuses `DEV_*` auth modes in production**. Ansible should **not** template `DEV_OPEN_AUTH`, `DEV_IN_MEMORY`, or `DEV_DEFAULT_WEB_USER` for production groups. Staging may mirror prod with stricter network ACLs if you need isolated testing.

### Secret delivery pattern

1. Template **`/etc/ksc-tower/backend.env`** with `0600` owner `root:tower` or owned by `tower` only.
2. systemd: `EnvironmentFile=/etc/ksc-tower/backend.env`.
3. Optionally later: HashiCorp Vault / cloud secret manager; Ansible becomes a bootstrap only.

---

## 8. Role specifications

### 8.1 `common`

- Create **`tower`** user and group, home directory optional (`/var/lib/ksc-tower`).
- Packages: `curl`, `ca-certificates`, `jq`, `git` (if deploy-from-git), `logrotate` (optional).
- **Time sync** (chrony) for JWT and DB replication sanity.
- **sysctl** / file limits if you expect high concurrency (optional; tune after metrics).

### 8.2 `firewall` (ufw or nftables)

Per [ARCHITECTURE.md](ARCHITECTURE.md):

| Direction | Rule |
|-----------|------|
| Inbound TCP | **443** (and **80** only if needed for ACME HTTP-01). |
| Inbound TCP | **Backend `PORT`** only if something hits Node directly (prefer **not** — keep Node on loopback). |
| Inbound UDP | None. Keep `LIVE_UDP_ENABLED=false`; do not expose **48788/UDP** publicly. |
| Inbound | **Deny** MariaDB (**3306**) and Redis (**6379**) from the public internet; bind to loopback or private interface. |

Document **source IP restrictions** if the tower is private (e.g. VPN-only): Ansible can template allowlists.

### 8.3 `mariadb`

- Install MariaDB server package.
- **`bind-address`**: `127.0.0.1` if DB is co-located with API; private LAN IP if split.
- Create database **`ksc_tower`** (or variable) and application user with least privilege.
- Charset/collation consistent with app expectations (UTF-8).
- **Schema strategy**: today the app runs **`initDbSchema`** on startup when DB is reachable. Ansible can rely on that **or** you can add explicit migration playbooks later for stricter change control.

### 8.4 `redis`

- Install Redis.
- **`bind`**: loopback or private net only; **`requirepass`** if not localhost-only.
- Persistence: **RDB** and/or **AOF** per your durability needs (queues may tolerate brief loss; document tradeoffs).

### 8.5 `nodejs`

- Install Node **LTS** via NodeSource, nvm system install, or distro packages **only** if new enough.
- Pin **major** version in variables; CI and prod should match.

### 8.6 `nginx` (or `caddy`)

- TLS certificates: **Let’s Encrypt** (certbot hook) or bring-your-own PEM paths.
- **Upstream**: `proxy_pass http://127.0.0.1:{{ backend_port }};`
- **WebSocket**: location matching backend **`LIVE_WS_PATH`** (default `/v1/live/ws`) with:
  - `proxy_http_version 1.1`
  - `Upgrade` and `Connection` headers
  - Sensible **timeouts** (long-lived WS)
- **Headers**: `X-Forwarded-For`, `X-Forwarded-Proto`, `Host` — align with **`TRUST_PROXY`** on the app.
- **Security**: TLS ciphers modern profile; **HSTS** once stable; rate limiting at edge (optional) — complements Express rate limits.

### 8.7 `ksc_backend`

**Deploy sources (choose one):**

1. **Git on server**: clone/pull tag, `npm ci --omit=dev`, `npm run build`.
2. **Artifact**: rsync/unpack tarball from CI to `/opt/ksc-tower/backend`, `npm ci --omit=dev` **or** ship `node_modules` + `dist` from CI (faster, larger artifact).

**systemd unit** (conceptual):

- `After=network-online.target mariadb.service redis-server.service`
- `User=tower`, `Group=tower`
- `WorkingDirectory=/opt/ksc-tower/backend`
- `ExecStart=/usr/bin/node dist/index.js`
- `Restart=on-failure`, `RestartSec=5`
- `EnvironmentFile=/etc/ksc-tower/backend.env`
- `AmbientCapabilities=` — none required if binding high ports; if you ever bind **80/443** in Node directly, use proxy instead.

**Handlers**: `daemon-reload`, `restart ksc-tower-backend`.

### 8.8 `ksc_web` (optional)

- On build node or target: `npm ci`, `npm run build`.
- Sync `dist/` to e.g. `/var/www/ksc-tower/html/`.
- nginx: `root` + `try_files $uri /index.html` for SPA routing.
- Ensure **`CORS_ORIGINS`** lists this exact **origin** (`https://tower.example.com`, not a path).

### 8.9 `monitoring` (optional)

- **Health**: cron or blackbox check `GET https://api…/v1/health`.
- **Metrics**: node_exporter + Prometheus, or cloud monitoring agent.
- **Logs**: journald forwarder (Vector, Loki, etc.) — optional role.

---

## 9. Environment variable checklist (backend)

Authoritative schema: `backend/src/config/env.ts`. Operator-oriented list: `backend/.env.example` and [DEPLOYMENT.md](DEPLOYMENT.md).

**Production minimum (typical):**

- `NODE_ENV=production`
- `PORT` (internal)
- `APP_JWT_SECRET`
- `MARIADB_*`, `REDIS_URL`
- `CORS_ORIGINS` (explicit comma-separated origins)
- `TRUST_PROXY` (match nginx hops)
- LiveKit: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` and/or `LIVEKIT_URL`
- Clerk **or** email/password model via `WEB_LOGIN_USERS_JSON` / registration modes — product decision
- `LIVEKIT_BRIDGE_IDENTITIES` / `LIVEKIT_BRIDGE_DISPLAY_NAME` if defaults are fine, else override

**Networking / live transport:**

- `LIVE_UDP_ENABLED=false` in production; no public firewall rule for `LIVE_UDP_PORT`
- `LIVE_WS_ENABLED`, `LIVE_WS_PATH` — nginx must allow WS upgrade on that path

**Operational / branding (optional):**

- `REGISTRATION_MODE`, `PROJECT_*`, `PLUGIN_*` URLs for landing page — see `.env.example`

---

## 10. Voice bridge (separate footprint)

The voice bridge (`KSCTowerNetwork-voice-bridge/voice-bridge/`) connects **KSP over TCP** to **LiveKit**. Defaults assume a **Windows** KSP process name for watchdog behavior (`bridge.ts`).

| Deployment | Ansible |
|------------|---------|
| **Normal** — bridge on pilot PC with KSP | **Do not** deploy with server `site.yml`. Document manual install or a **Windows**-specific automation outside this Linux plan. |
| **Headless bridge** on Linux | Separate inventory group `tower_bridge`; template `TOWER_API_BASE`, `PCM_*`, `CTL_*`, `BRIDGE_IDENTITY`, `SESSION_ID`; fix **`KSP_PROCESS_NAME`** / **`KSP_WATCHDOG`** for Linux; open only required ports. |

**Note:** Both voice-bridge packages require Node 24 or newer from `PATH`. Use the maintained inner `voice-bridge/package.json` for Linux servers; the outer package is a legacy source entrypoint.

---

## 11. Playbooks (execution map)

| Playbook | Runs on | Purpose |
|----------|---------|---------|
| `site.yml` | `tower_api` (+ `tower_db` if included) | Greenfield: OS packages, DB, Redis, Node, nginx, backend, optional web. |
| `db.yml` | `tower_db` or db group on same host | Idempotent DB/Redis only. |
| `app.yml` | `tower_api` | Code deploy, `npm ci`/`build` if needed, restart backend, reload nginx. |

**Tags** (recommended): `common`, `firewall`, `db`, `app`, `nginx`, `web` — so you can run `-t app` for frequent deploys.

---

## 12. Validation and smoke tests

After a playbook run:

1. `curl -fsS https://<api>/v1/health` — expect 200 and JSON indicating DB/Redis reachability as configured.
2. Confirm the public firewall has no inbound rule for **48788/UDP**.
3. Open tower **web** origin in browser; confirm API calls succeed (no CORS errors).
4. **WebSocket**: open devtools → Network → WS on `LIVE_WS_PATH` during a session (tower desk).

---

## 13. Staging vs production

| Aspect | Staging | Production |
|--------|---------|------------|
| Inventory | `inventories/staging/` | `inventories/production/` |
| Secrets | Separate Vault password / file | Stricter access control |
| `DEV_*` | Avoid mirroring “open auth”; use test users in DB or JSON | All `DEV_*` off |
| Firewall | Can restrict source IPs to team VPN | Public HTTPS only; no UDP telemetry port |
| Domain | `staging-api…` | Production hostnames |

---

## 14. Milestones (implementation order)

1. **Bootstrap**: `common` + `nodejs` + `tower` user + directory layout.
2. **Data**: `mariadb` + `redis` on loopback/private; verify backend connects.
3. **App**: `ksc_backend` + systemd + templated `backend.env` from Vault.
4. **Edge**: `nginx` + TLS + WS location; set `TRUST_PROXY` and `CORS_ORIGINS`.
5. **Firewall**: `firewall` role last on first deploy, or use “allow SSH first” ordering to avoid lockout.
6. **Web**: `ksc_web` if SPA is co-hosted.
7. **Hardening**: fail2ban (optional), automated security updates (optional), backup role for MariaDB dumps.

---

## 15. Open decisions (record answers as you implement)

1. **Same host vs split**: MariaDB/Redis on API box vs managed cloud DB/Redis (Ansible shrinks to app + proxy only).
2. **Deploy mechanism**: git pull on server vs CI artifact (affects `ksc_backend` role design).
3. **Web hosting**: same nginx vhost vs Cloudflare Pages / Vercel (if separate, `CORS_ORIGINS` and cookie behavior need explicit testing).
4. **UDP**: keep public UDP disabled; authenticated pilot traffic uses HTTPS ([ARCHITECTURE.md](ARCHITECTURE.md)).
5. **Backup and restore**: who runs `mysqldump` cron, retention, off-site copy.

---

## 16. Summary

Ansible should **own the machine**: users, packages, firewall, TLS edge, systemd, and **templated configuration**. It should **invoke** existing Node build/run conventions (`npm ci`, `npm run build`, `node dist/index.js`) rather than reimplementing them. Keep the **voice bridge** and **KSP plugin build** out of the default server playbook unless you deliberately design those as separate Ansible projects or groups.

When this plan is approved, the next concrete step is adding `KSCTowerNetwork-dev/ansible/` with `inventories/`, `group_vars/`, and a minimal `app.yml` + `ksc_backend` role **without** committing secrets (Vault only).
