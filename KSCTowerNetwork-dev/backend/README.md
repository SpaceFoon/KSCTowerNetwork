# KSC Tower Backend (MVP)

Express + TypeScript backend scaffold for the KSC Tower Network project.

## Stack

- Express API (`/v1/*`)
- Clerk token verification
- KerbalX-style plugin auth exchange flow
- MariaDB and Redis connectivity hooks
- MariaDB + Redis backed repository layer (with local fallback if dependencies are offline)
- LiveKit token issuing endpoints and room bootstrap

## Quick start

1. Copy `.env.example` to `.env` and fill secrets. For **local dev without Clerk**, set `DEV_BEARER_SECRET` (20+ chars) and paste that string as `Authorization: Bearer …` in the web UI / KSP plugin; set `ADMIN_USER_IDS` to match `DEV_USER_ID` if you need admin pages.
   - **Env file load order (non-production):** `.env` is loaded first, then `.env.development` (if present) overrides it. Put LiveKit keys in either file; restart the backend after changes.
2. Install dependencies:
   - `npm install`
3. Run development server:
   - `npm run dev`

## Implemented endpoints

- `GET /v1/health`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/queue/join`
- `POST /v1/queue/leave`
- `POST /v1/auth/plugin/exchange-code`
- `POST /v1/auth/plugin/exchange`
- `POST /v1/session/call`
- `GET /v1/session/:sessionId`
- `GET /v1/session/:sessionId/messages` (optional `?since=` ISO timestamp for incremental poll)
- `POST /v1/session/:sessionId/messages` (body `{ "text": "..." }`, max 4000 chars)
- `GET /v1/lobby/messages`
- `POST /v1/lobby/messages`
- `GET /v1/lobby/rooms`
- `POST /v1/session/:sessionId/next-tower`
- `POST /v1/session/:sessionId/block`
- `POST /v1/session/:sessionId/livekit-token`
- `POST /v1/telemetry/:sessionId`
- `POST /v1/report`
- `GET /v1/admin/reports`
- `POST /v1/admin/ban`
- `GET /v1/admin/logs`
- `GET /v1/admin/rooms/tower` — active tower sessions (not `closed`); admin visibility only
- `GET /v1/admin/rooms/chat` — chat traffic by `sessionId` (message counts + last activity)

## Notes

- Role scope is `tower` only for v1.
- **Rooms model:** A **session** is the unit for both tower ops and chat. LiveKit uses `tower-{sessionId}`. **Pilots and plugins do not choose a room:** they call `POST /v1/session/call` and use the returned `sessionId` for chat, telemetry, and voice. Admins use `/admin/rooms/*` to see what is live.
- **Web login model (email/password):** `POST /v1/auth/login` issues a backend JWT with `token_type=tower_web`, handled as a browser user (`tokenType=clerk`) for room/listen permissions. Configure users via `WEB_LOGIN_USERS_JSON`; fallback local dev account is `tower@ksc.local` / `tower12345`.

## Voice (LiveKit)

- Configure `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_WS_URL` (wss URL from LiveKit Cloud or self-hosted).
- `POST /v1/session/:sessionId/livekit-token` returns `{ token, wsUrl, roomName, canPublish, canSubscribe, flavor }`. **Ops** (`flavor` default / `ops`): pilot and assigned tower may publish; subscribe from the web is limited to the assigned tower, moderators, and the KSP voice-bridge identity (e.g. `ksp_bridge`); everyone else gets `403` `voice_room_subscribe_denied`. **Lobby listen** (`{ "flavor": "lobby_ops" }`): subscribe-only to the same ops room for pilot-tier lobby users without session roster membership.
- **Dev two-browser testing:** with `DEV_OPEN_AUTH=true`, set `DEV_VOICE_IDENTITY_HEADER` (see `.env.example`). The web Voice desk can send that header so tab A uses e.g. `pilot1` and tab B uses `tower1`, then create/assign a session so those ids match `pilotUserId` / `assignedTowerUserId` (via DB or session APIs) for realistic publish rules.
- Tower queue endpoints require Clerk-authenticated users with `tower` role.
- Session control authorization:
  - telemetry: pilot only
  - next-tower/block: pilot, assigned tower, or admin
- Telemetry cadence recommendation is adaptive:
  - every 5 seconds by default
  - every 1 second below 15000m AGL
- Plugin login flow:
  - Authenticated web app requests exchange code (`/auth/plugin/exchange-code`)
  - KSP plugin redeems code for plugin session token (`/auth/plugin/exchange`)
- Persistence now writes to MariaDB/Redis when available and falls back locally if services are offline.
