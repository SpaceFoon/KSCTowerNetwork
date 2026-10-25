# Deployment

## Recommended: Ubuntu installer

For a fresh Ubuntu 22.04 or 24.04 LTS VPS or VM, configure the installer and run
`sudo bash setup-vps.sh`. It installs and configures the backend, website,
MariaDB, Redis, HTTPS, firewall and backend systemd service, and writes the
production environment to `/etc/ksctower.env`. Follow the
[Ubuntu installer guide](../deploy/README.md). A VM needs a reachable address
and the required ports forwarded. Cloudflare is optional; voice uses the
LiveKit service in your configuration.

The reference below describes the components and settings. For the prebuilt
Server ZIP or an already prepared Linux/Windows host, use the alternative
[manual/server-only guide](SERVER_HOSTING.md).

## Topology

```
End user PC                     Operator infra
─────────────                   ───────────────────────────────────
KSP                             Backend         (e.g. Railway, Render, VPS)
  └─ KSCTowerNetwork plugin       └─ MariaDB
       │                          └─ Redis
       │ HTTPS /v1                Web SPA       (e.g. Vercel, Netlify, CFP)
       │                            └─ static dist/
       └─ TCP loopback           LiveKit Cloud (or self-hosted)
       ▼                                ▲
Voice bridge ─────── wss ──────────────┘
```

End-user URLs that need to match:

- Plugin's in-game **Server address** → backend public URL (`settings.cfg` supplies initial defaults).
- Plugin's `webBaseUrl` (in the login GUI) → web SPA public URL.
- Backend `LIVEKIT_WS_URL` → configured LiveKit service; the bridge obtains its connection details from the backend.
- Backend's `CORS_ORIGINS` → web SPA's exact origin.

**Ports / UDP / WebSocket:** authenticated plugin traffic uses HTTPS through
the API. The optional local-development UDP listener (`LIVE_UDP_PORT`, default
**48788**) is disabled by default and must not be opened publicly. Full matrix:
[ARCHITECTURE.md → Ports, firewall, live transport](ARCHITECTURE.md#ports-firewall-and-live-transport).
Load expectations: [PERFORMANCE_AND_HOT_PATHS.md](PERFORMANCE_AND_HOT_PATHS.md).

## Backend

### Required env (production)

```
NODE_ENV=production
APP_JWT_SECRET=<long random; not the dev default>
WEB_LOGIN_USERS_JSON=<JSON array of users with passwordHash>
OWNER_USER_ID=<single user id>
CORS_ORIGINS=https://tower.example.com
LIVEKIT_API_KEY=<from livekit cloud>
LIVEKIT_API_SECRET=<from livekit cloud>
LIVEKIT_WS_URL=wss://<your-project>.livekit.cloud
MARIADB_HOST=...
MARIADB_PORT=3306
MARIADB_USER=...
MARIADB_PASSWORD=...
MARIADB_DATABASE=ksc_tower
REDIS_URL=redis://default:...@host:6379
```

If development auth/bypass flags are enabled, the backend **will refuse to start** in
production. That's deliberate.

### Build / run

```bash
cd backend
npm ci
npm run build      # → dist/
node dist/index.js
```

Or run with `tsx` if you don't care about the build step.

### Reverse proxy

Behind nginx/Caddy, terminate TLS at the proxy and forward to the Node
port. Set `TRUST_PROXY` for the actual proxy topology (one hop for the direct proxy recipe) so
`req.ip` honors the proxy's `X-Forwarded-For`.

Don't strip the `Authorization` header. Don't rewrite paths under `/v1`.

### MariaDB

Schema is created automatically by `runMigrations()`. The user needs:

```sql
CREATE USER 'ksc_tower'@'%' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON ksc_tower.* TO 'ksc_tower'@'%';
FLUSH PRIVILEGES;
```

(Restrict the GRANT to the specific tables if your security policy
requires it. The migration runner only does CREATE TABLE IF NOT EXISTS.)

### Redis

Optional but recommended. Without it, queues become process-local and
will lose state if you scale to >1 instance.

## Web SPA

### Build

```bash
cd web
npm ci
npm run build      # → dist/
```

### Hosting

Deploy `web/dist/` to any static host. Make sure:

1. The host serves `index.html` for unknown paths (SPA fallback).
2. The host's domain is in the backend's `CORS_ORIGINS`.
3. (Optional) `VITE_API_BASE` is set at build time if the backend is on a
   different origin; leave unset for same-origin `/v1` (recommended behind nginx).

For Vercel/Netlify/Cloudflare Pages: standard "Vite" preset works.

## LiveKit

Recommended: **LiveKit Cloud**. Create a project, copy the API key,
secret, and wsUrl into the backend's env.

Self-hosted: set `LIVEKIT_WS_URL` to your `wss://your-livekit:7880` URL.
The same API key/secret pattern applies.

The voice bridge identity (`ksp_bridge` by default) needs to be allowed
to subscribe but **not publish** — `services/livekit.ts` enforces this
via the token grant.

## Client and server release ZIPs

See [RELEASING.md](RELEASING.md) for the verified two-package build and publication
workflow. The Client ZIP contains a Windows x64 KSP plugin and bundled bridge;
pilots select their operator's server in the in-game **Tower login** window.

1. Close KSP and extract the Client ZIP's `GameData` folder into the KSP directory.
2. Launch KSP and click the **Tower** toolbar button (available on the main menu).
3. Enter the operator's **Server address**, then email/password, and click **Log in**.
   A hostname or IP uses HTTPS, for example `tower.example.com`. For a server
   using HTTP, enter its complete URL, such as `http://192.168.1.12:48787`.
   Root URLs gain `/v1` automatically; a complete API path is also accepted.
4. The server is saved automatically. To change it later, **Log out**, open the
   Tower toolbar button again, and enter the new address.

For a separate API and website deployment, enable **Web desk uses a separate
address (advanced)** and enter the operator's website URL. Most deployments
use the same address for both. The client updates the bundled voice bridge
and live UDP host to follow the selected API; HTTP fallback remains enabled.
Server choices live in plugin-owned `auth.cfg`; players do not edit config files.
Preserve `auth.cfg` and personal `settings.cfg` when updating the client.

The Server address field is included from Client v1.0.1. Players on v1.0.0
must update the Client ZIP to gain it; updating only the server is insufficient.

The Server ZIP contains the built backend and same-origin website. Operators
install production dependencies using deploy/server.sh install (or server.ps1
install) and follow [SERVER_HOSTING.md](SERVER_HOSTING.md) for private production
configuration, database/cache, HTTPS and service supervision. Controllers visit
the website. Private release-config.json is not used in neutral public releases.

## Smoke tests after deploy

From a non-developer machine:

```bash
curl https://api.example.com/v1/health
# → {"ok":true}

curl -X POST https://api.example.com/v1/auth/guest -H 'Content-Type: application/json' -d '{}'
# → {"token":"...","user":{...}}
```

Then in a browser:

1. Open the web SPA URL.
2. Log in with one of your `WEB_LOGIN_USERS_JSON` users.
3. Watch the network tab for `/v1/auth/me` 200 with the right role.
4. Open `TowerDesk` (if `controller`+).
5. Confirm LiveKit connection (network tab shows `wss://…livekit.cloud`).

## Rolling updates

- Backend: preserve MariaDB, private env/JWT secret, and local `backend/data` stores across updates. JWTs survive while their signing secret remains unchanged.
- Web SPA: pure static; redeploy whenever.
- LiveKit: managed by provider.
- Plugin/bridge: ship a new release ZIP. Old `auth.cfg` JWTs keep working
  unless you rotated `APP_JWT_SECRET`.

## Things that will break players

| Change | Player impact |
|---|---|
| Rotating `APP_JWT_SECRET` | All `plugin_session` JWTs invalidated; players re-pair via login GUI. |
| Changing the LiveKit endpoint/keys | Update the server env and restart it; clients obtain connection details from the backend. Verify reconnection. |
| Changing the backend hostname | Pilots log out and enter the new Server address in Tower login; no server-specific client rebuild is needed. |
| Tightening `CORS_ORIGINS` to exclude an old web hostname | Browser users on the old hostname get CORS errors. |

## Things that won't break players

- Adding new routes (old plugins ignore unknown response fields).
- Changing the controller-side UI (no plugin redeploy needed).
- Adding new capabilities to existing roles.
- Migrating MariaDB schema additively.
