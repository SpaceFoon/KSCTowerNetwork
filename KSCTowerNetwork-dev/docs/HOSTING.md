# KSCTowerNetwork — Going Live on Real Hostnames

This is the short, ordered checklist for taking the mod from "works on my
machine" to "users download it and it just works against your hosted tower".

The codebase already supports everything below; the only thing that changes
between deployments is **where the hostnames live**. There is exactly one
source of truth: `release-config.json`.

---

## 1. Pick your hostnames

Three URLs are involved:

| What | Example | Where it goes |
|---|---|---|
| Backend API | `https://api.tower.example.com` | Deployed Node app (Railway / Fly / Render / VPS) |
| Web SPA | `https://tower.example.com` | Static host (Cloudflare Pages / Vercel / Netlify) — or same origin as backend |
| LiveKit WS | `wss://your-project.livekit.cloud` | LiveKit Cloud project |

Single-origin (backend serves the SPA) is also fine — set `web.origin` equal
to `backend.origin` in the config below and `package-release.ps1` will leave
`VITE_API_BASE` unset so the SPA uses relative `/v1` paths.

## 2. Fill out `release-config.json`

```bash
cd GameData/KSCTowerNetwork
cp release-config.example.json release-config.json
$EDITOR release-config.json
```

This file is read by `package-release.ps1` and bakes its values into:

- `PluginData/settings.cfg` (`towerApiHost`, `towerApiPort`, `towerApiPath`, `towerApiTls`, `sessionId`)
- `PluginData/bridge-runtime/start-bridge.cmd` (`TOWER_API_BASE`, `SESSION_ID`)
- The web SPA build (`VITE_API_BASE`)
- `RELEASE_MANIFEST.txt` (for forum posts / CKAN listings)

`release-config.json` is gitignored (or treated as such) — never commit it
filled in for someone else's deployment.

## 3. Stand up the backend

Required env vars in production (on Railway/Fly/wherever):

```env
NODE_ENV=production
PORT=48787

APP_JWT_SECRET=<long random string, e.g. openssl rand -hex 32>

LIVEKIT_API_KEY=<from LiveKit Cloud>
LIVEKIT_API_SECRET=<from LiveKit Cloud>
LIVEKIT_WS_URL=wss://your-project.livekit.cloud

CORS_ORIGINS=https://tower.example.com

# DB. The backend auto-creates schema on first run.
MARIADB_HOST=...
MARIADB_PORT=3306
MARIADB_USER=...
MARIADB_PASSWORD=...
MARIADB_DATABASE=ksc_tower
REDIS_URL=redis://...

# Web login users (until Clerk is wired up). JSON array; passwords are plaintext, treat as a temporary measure.
WEB_LOGIN_USERS_JSON=[{"email":"you@example.com","password":"chooseSomethingDecent","userId":"owner"}]
OWNER_USER_ID=owner

# Optional: enable Clerk later by setting these (no other code change needed).
# CLERK_SECRET_KEY=sk_live_xxx
# CLERK_JWT_KEY=-----BEGIN PUBLIC KEY-----\n...
```

`backend/src/config/env.ts` will refuse to boot in production if any
`DEV_OPEN_AUTH` / `DEV_BEARER_SECRET` / `DEV_VOICE_IDENTITY_HEADER` /
`DEV_DEFAULT_WEB_USER` / `DEV_IN_MEMORY` flag is set, and if `APP_JWT_SECRET`
is still the dev default. Those guards are intentional — leave them on.

## 4. Stand up the web (only if split origin)

If you went with the split-origin model:

```bash
cd GameData/KSCTowerNetwork/web
cp .env.production.example .env.production
# edit .env.production: VITE_API_BASE=https://api.tower.example.com
npm ci
npm run build
# Deploy web/dist/ to Cloudflare Pages / Vercel / Netlify.
```

Make sure your static host falls all 404s through to `index.html` (SPA
routing). Vercel/Netlify do this automatically with a `_redirects` file:

```
/*    /index.html    200
```

If you went single-origin, skip this — the backend will serve the SPA bundle.

## 5. LiveKit Cloud

1. Create a project at https://cloud.livekit.io.
2. Copy the API Key, API Secret, and the WS URL into the backend env above.
3. That's it — no other LiveKit config is needed; rooms are created on demand
   when the backend mints tokens.

## 6. Build the player release

From `KSCTowerNetwork-voice-bridge/voice-bridge/`:

```powershell
# One-time: build the bridge runtime with bundled node.exe.
powershell -ExecutionPolicy Bypass -File .\scripts\build-bridge-runtime.ps1 `
  -NodeExePath "C:\path\to\node.exe"

# Every release: stage + zip with hostnames baked in.
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

Output: `release/KSCTowerNetwork-<version>.zip`. That ZIP is the file players
download. Inside is a single top-level `GameData/KSCTowerNetwork/` folder they
drop into their KSP install.

The script refuses to package if `node.exe`, `bridge.js`, or
`KSCTowerNetwork.Client.dll` is missing, and prints a `RELEASE_MANIFEST.txt`
with SHA256s of the binaries for your forum/CKAN listing.

## 7. Verify a fresh install

On a different machine (or a fresh KSP profile) drop the ZIP's `GameData/`
contents into `Kerbal Space Program/GameData/`. Launch KSP. Expected
sequence:

1. KSP main menu loads. The bridge launcher addon spawns
   `PluginData/bridge-runtime/start-bridge.cmd`. A child node.exe shows up
   in Task Manager.
2. Bridge logs (in `PluginData/bridge-runtime/` — pipe stdout to a file via
   `start-bridge.cmd > bridge.log 2>&1` if you want it persisted) show:
   ```
   [voice-bridge] PCM TCP 127.0.0.1:47372 ...
   [voice-bridge] LiveKit connected (session tower-public)
   ```
3. Player opens `https://tower.example.com/` in any browser, logs in,
   joins the `tower-public` (or whatever you set) channel.
4. Player launches a flight in KSP, opens the Tower toolbar window, hits PTT.
   Web tab hears them; pressing PTT in the web tab sends audio back into KSP.
5. Player quits KSP. Bridge watchdog sees `KSP_x64.exe` gone, exits within
   ~15 seconds. Web Participants list drops `ksp_bridge`.

If step 1 fails: open `start-bridge.cmd` in a terminal, check the FATAL
message. If step 3 fails: check CORS — backend must list the web origin in
`CORS_ORIGINS`.

## 8. Auth upgrades (optional, do later)

Current state of auth (already implemented, just not all turned on):

| Path | Backend support | Web support | Plugin support |
|---|---|---|---|
| Hardcoded `WEB_LOGIN_USERS_JSON` (legacy) | yes | yes (LoginPage.tsx) | yes (TowerLoginGui) |
| `plugin_session` JWT issued from `/v1/auth/login` | yes | n/a | yes (used by KSP) |
| `guest` JWT for anonymous browser viewers | yes | yes | n/a |
| Clerk session tokens (with email verification) | yes (verifyToken in `middleware/auth.ts`) | TODO: wrap App in `<ClerkProvider>` | not needed — keeps using `plugin_session` |

To switch the web login over to Clerk: install `@clerk/clerk-react`, wrap
`<App>` in `<ClerkProvider>`, replace `LoginPage.tsx`'s email/password form
with Clerk's `<SignIn>` and pass the resulting session token via the existing
`Authorization: Bearer …` header. Backend needs no changes other than setting
`CLERK_SECRET_KEY` and/or `CLERK_JWT_KEY`.
