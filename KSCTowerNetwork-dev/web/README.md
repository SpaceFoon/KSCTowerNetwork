# KSC Tower Web (React)

Small SPA for **tower operators** (queue + plugin exchange code), **session text chat** (`/chat`), **voice** (`/voice` via LiveKit), and **admins** (reports, logs, bans). It talks to the same backend as the KSP plugin.

## Run (development)

1. Start the backend (`npm run dev` in `../backend`, default port `48787`).
2. From this folder:

```bash
npm install
npm run dev
```

3. Open the URL Vite prints (usually `http://localhost:45173`).

Requests go to `/v1/...` on the Vite dev server, which **proxies** to `http://127.0.0.1:48787`.

## Voice (manual test)

Prerequisites: backend has `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_WS_URL` set; same bearer token behavior as other `/v1` routes.

1. Start backend + `npm run dev` for this app.
2. Open `/voice` in two browser profiles or two machines; use the **same session id** (e.g. `dev-shared` or create a session as pilot on one side and paste the id on the other).
3. **Connect** on both. Pilot/assigned tower should see publish capability; others may be subscribe-only (banner on the Voice page).
4. Confirm remote audio and **speaking** indicators when one side talks; use **Mute** to verify local track toggles.
5. Negative checks: revoke mic permission (expect clear error + reconnect after fixing); stop backend LiveKit env (expect 503 from token route); wrong session id (404) or disallowed role (403).

## Auth

- Paste a **Clerk session JWT** in **Session token** and click **Save to browser**.
- **Tower desk**: queue endpoints need a Clerk token and `users.role = tower` in the DB (when MariaDB is used). In pure in-memory fallback without DB, role defaults may block queue; use DB or adjust backend for dev.
- **Admin**: your Clerk user id must appear in backend `ADMIN_USER_IDS`.

## Voice (`/voice`)

- Backend must have valid `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_WS_URL`.
- Open **Voice**, enter the same **session id** as chat, then **Connect**. The app calls `POST /v1/session/:sessionId/livekit-token` and joins the LiveKit room `tower-{sessionId}`.
- **Dev two-tab testing:** set backend `DEV_VOICE_IDENTITY_HEADER` (see backend `.env.example`) to match `web/src/api/devVoice.ts`. Fill **Dev voice id** per tab (e.g. `pilot1` / `tower1`) so each tab maps to a different backend user when `DEV_OPEN_AUTH=true`; align session `pilotUserId` / `assignedTowerUserId` in your DB or via APIs so both may publish.

## Production build

```bash
npm run build
```

Serve the `dist` folder behind your real HTTPS host and point API calls at the same origin or set up a reverse proxy to `/v1`.

## Voice + Kerbalizer (send-path DSP)

- **Voice (`/voice`)**: LiveKit room audio. Enable **Kerbalizer** before **Connect** to run outgoing mic through high-pass, band-limit, soft saturation, and formant-style peaking (AudioWorklet when available; main-thread biquad + waveshaper fallback).
- **Kerbalizer lab (`/kerbalizer-lab`)**: Mic + meters only (no LiveKit), useful for tuning effect strength without joining a room.
- **LiveKit integration**: Processed audio is published via `localParticipant.publishTrack(processedTrack)`; disabling the effect (`enabled: false`) is a cheap bypass inside the worklet (instant dry path).
- **CPU target**: On a typical desktop/laptop, expect on the order of **1–3% of one core** for mono 48 kHz while connected (worklet path); the fallback path is slightly heavier on the main thread. If you hear glitches, reduce **strength** / **wet** or turn Kerbalizer off.

## Note on folder location

Like the Node backend, this folder is easier to maintain **outside** `GameData` so KSP does not scan thousands of `node_modules` files. You can move `web` anywhere and only keep `Plugins/` + `PluginSrc/` under `GameData`.
