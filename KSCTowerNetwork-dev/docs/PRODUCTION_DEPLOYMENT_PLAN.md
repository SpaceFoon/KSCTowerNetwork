# KSC Tower Network — Production Deployment Plan

## Overview

This document covers moving from local dev (`localhost`) to a real internet-accessible deployment so multiple players can use the tower system from anywhere.

The architecture stays the same. What changes is where each piece runs.

```
[Pilot PC]
  KSP + plugin  →  local voice-bridge  →  LiveKit Cloud  ←  Tower browser (anywhere)
       |                                                           |
       └───────────────  backend (cloud)  ───────────────────────┘
```

---

## Components and Where They Run

| Component | Dev (now) | Production |
|---|---|---|
| Backend API | localhost:8787 | Cloud server (Railway / Render / VPS) |
| Web frontend | localhost:5173 | Vercel / Netlify / Cloudflare Pages |
| Voice bridge | localhost (with KSP) | Still runs on pilot's PC |
| KSP plugin | pilot's PC | pilot's PC |
| LiveKit | LiveKit Cloud (already) | LiveKit Cloud (same) |
| Database | in-memory | MariaDB / Postgres (managed) |

---

## Step 1 — LiveKit Cloud Account

1. Create account at https://cloud.livekit.io (free tier available).
2. Create a project.
3. Copy the three values you need:
   - `LIVEKIT_URL` — looks like `wss://your-project.livekit.cloud`
   - `LIVEKIT_API_KEY` — starts with `API...`
   - `LIVEKIT_API_SECRET` — long random string

These go into the backend environment variables (see Step 2).

---

## Step 2 — Deploy Backend

### Recommended platforms
- **Railway** (easiest, built-in Postgres/MariaDB, free tier)
- **Render** (free tier, slightly slower cold starts)
- **Any VPS** (DigitalOcean, Hetzner, Linode — full control)

### Environment variables to set in production

```env
NODE_ENV=production

# LiveKit (from Step 1)
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# Auth
APP_JWT_SECRET=long_random_secret_here

# Turn off dev open auth
DEV_OPEN_AUTH=false

# Database (Railway/Render provide connection string)
DATABASE_URL=mysql://user:pass@host:3306/dbname

# Optional: Clerk auth for real user accounts (see Step 5)
CLERK_SECRET_KEY=sk_live_...
CLERK_JWT_KEY=...

# Admins (comma-separated user IDs)
ADMIN_USER_IDS=your_clerk_user_id
```

### What to disable in production
- `DEV_OPEN_AUTH` must be `false`
- `DEV_BEARER_SECRET` should be removed or kept only for testing
- `DEV_VOICE_IDENTITY_HEADER` is only needed in dev

### Build and start
```bash
npm install
npm run build   # if applicable
npm start
```

---

## Step 3 — Deploy Web Frontend

### Recommended platforms
- **Vercel** (easiest, free, auto-deploys from git)
- **Netlify** (free, easy)
- **Cloudflare Pages** (free, fast globally)

### Build command
```bash
cd web
npm install
npm run build
# Output is in web/dist/
```

### Environment variable for web build
```env
VITE_API_BASE=https://your-backend-domain.com
```

This tells the web app where to send API calls. Without this it defaults to `/v1` (relative, works when proxied in dev but not in production).

### Routing
All routes must fall through to `index.html` (standard SPA setup). Vercel/Netlify handle this automatically with a `_redirects` file or `vercel.json`.

Add to `web/public/_redirects`:
```
/*    /index.html    200
```

---

## Step 4 — Voice Bridge (stays on pilot's PC)

No deployment needed. The bridge runs **locally on the pilot's machine** alongside KSP.

It connects **outbound** to LiveKit Cloud — no inbound ports or firewall rules required.

### One change needed: point it at deployed backend

Set this environment variable before running the bridge, or add to a `.env` file in the `voice-bridge` folder:

```env
TOWER_API_BASE=https://your-backend-domain.com/v1
SESSION_ID=dev-shared
```

Or pass inline:
```bash
TOWER_API_BASE=https://your-backend-domain.com/v1 npm start
```

---

## Step 5 — KSP Plugin (backend URL)

The plugin currently has the backend URL hardcoded to `http://127.0.0.1:8787`.

Update these two source files before building:

- `PluginSrc/TowerToolbar.cs` — `ApiBaseUrl` constant
- `PluginSrc/TowerTelemetryPublisher.cs` — `ApiBaseUrl` constant

Change:
```csharp
private const string ApiBaseUrl = "http://127.0.0.1:8787/v1";
```

To:
```csharp
private const string ApiBaseUrl = "https://your-backend-domain.com/v1";
```

Then rebuild:
```powershell
.\build-plugin.ps1
```

Distribute `Plugins/KSCTowerNetwork.Client.dll` to anyone running KSP with the mod.

---

## Step 6 — Authentication

In dev, `DEV_OPEN_AUTH=true` lets anyone in with no token.  
In production you need real auth.

### Option A: Clerk (recommended for player-facing)
1. Create account at https://clerk.com (free tier available).
2. Create an application.
3. Set in backend env:
   ```env
   CLERK_SECRET_KEY=sk_live_...
   CLERK_JWT_KEY=...
   ```
4. Add Clerk to the web frontend:
   - Install `@clerk/clerk-react`
   - Wrap app in `<ClerkProvider>`
   - Use Clerk session tokens in API calls

### Option B: Shared bearer token (quick, private groups only)
If you just want a trusted group of players without full auth:
```env
DEV_BEARER_SECRET=some_long_shared_secret
DEV_OPEN_AUTH=false
```
Players include this as `Authorization: Bearer some_long_shared_secret` in requests.  
Not ideal for large/public groups.

---

## Step 7 — Database

In dev the backend uses in-memory storage (lost on restart).  
In production you need a real database.

### Recommended: MariaDB or Postgres via Railway

Railway auto-provisions a database and gives you a `DATABASE_URL`.  
Set it in the backend env and the backend will use it instead of in-memory.

### Schema
The backend creates tables automatically on first run if the DB connection is live.

---

## Step 8 — HTTPS / TLS

Everything in production must be HTTPS because:
- LiveKit WebSocket requires `wss://` (only works from secure origins)
- Browser mic capture (`getUserMedia`) requires HTTPS
- Modern browsers block mixed HTTP/HTTPS content

Railway, Render, Vercel, and Netlify all provide HTTPS automatically with their managed domains. If you use a VPS, use Nginx + Let's Encrypt (Certbot).

---

## Step 9 — CORS

The backend must allow requests from your deployed web domain.

Check `backend/src/index.ts` for CORS config and add your production web domain:

```typescript
cors({
  origin: [
    "https://your-web-app.vercel.app",
    "https://your-custom-domain.com"
  ]
})
```

---

## Checklist

- [ ] LiveKit Cloud account created, credentials copied
- [ ] Backend deployed with production env vars
- [ ] `DEV_OPEN_AUTH=false` in production
- [ ] Real database connected
- [ ] HTTPS working on backend domain
- [ ] CORS updated to allow web domain
- [ ] Web frontend built with `VITE_API_BASE` set
- [ ] Web deployed and `_redirects` or equivalent configured
- [ ] Voice bridge `.env` updated with deployed backend URL
- [ ] KSP plugin source updated with deployed backend URL
- [ ] Plugin rebuilt and distributed
- [ ] Auth configured (Clerk or bearer secret)
- [ ] Test full flow: pilot in KSP → telemetry → tower web → voice both ways

---

## Quick Start Order

1. LiveKit Cloud (5 min)
2. Deploy backend to Railway with env vars (15 min)
3. Deploy web to Vercel pointing at backend (10 min)
4. Update voice bridge env on pilot PC (2 min)
5. Update and rebuild KSP plugin (5 min)
6. Test end-to-end
