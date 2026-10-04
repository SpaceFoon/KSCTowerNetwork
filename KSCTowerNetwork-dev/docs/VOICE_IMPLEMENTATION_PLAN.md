# KSCTower Voice Plan (Parallel AI Execution)

This plan is scoped to the existing KSCTower mod stack in `GameData/KSCTowerNetwork`:
- Backend: Express API with LiveKit token endpoint already present.
- Web: React app (`/tower`, `/chat`, `/admin`) with shared token storage and API client.
- KSP plugin: optional integration in v1 (status/deep-link only, no in-game WebRTC capture yet).

Primary goal: deliver reliable session voice + Kerbalizer in web first, using the current session model (`sessionId`, room `tower-{sessionId}`), then optionally expose convenience hooks in KSP.

---

## 1) Ground Truth (already in code)

- LiveKit token route exists: `POST /v1/session/:sessionId/livekit-token` in backend.
- Room naming exists and matches chat model: `tower-${session.id}`.
- Publish policy already enforced in backend route:
  - `pilot` and `assignedTowerUserId` can publish + subscribe.
  - Clerk-auth "admin-like" users can subscribe.
- LiveKit service helpers already exist:
  - `isLiveKitConfigured()`
  - `ensureLiveKitRoom()`
  - `issueLiveKitToken()`
- Dev auth mode exists (`DEV_OPEN_AUTH=true`), but all requests map to one `DEV_USER_ID` identity unless changed.

Implication: voice transport backend is mostly in place; fastest path is web client implementation + dev testability improvements.

---

## 2) Parallel Workstream Map (delegate to multiple AIs)

Use one AI per workstream. Workstreams A/B/C should begin immediately; D/E/F can run in parallel with minimal coupling.

## Workstream A - Backend Voice Hardening
**Owner:** AI-Backend-1  
**Scope:** `backend/src/routes/api.ts`, `backend/src/services/livekit.ts`, backend docs/env examples  
**Goal:** make token issuance explicit, testable, and dev-friendly for multi-user voice testing.

Tasks:
- Add request validation/response shape typing for `/livekit-token`.
- Add richer denial reasons/logging for publish/subscribe auth decisions.
- Add optional dev override for testing role scenarios without Clerk (example env knobs):
  - `DEV_OPEN_AUTH_USER_ID_HEADER` (if header present and allowlisted, map to identity for local multi-tab testing).
  - or explicit documented method for running two backend instances with different `DEV_USER_ID`.
- Ensure token response always includes `roomName`, `canPublish`, `canSubscribe`, `wsUrl`, `token`.
- Add/verify lightweight tests for:
  - pilot publish allowed
  - assigned tower publish allowed
  - unauthorized user subscribe denied
  - livekit misconfigured returns 503

Deliverables:
- Backend code updates + tests.
- Updated `backend/README.md` and `.env.example` for voice-dev flows.

Blocking deps: none.

---

## Workstream B - Web Voice Transport (LiveKit client)
**Owner:** AI-Web-Voice-1  
**Scope:** `web/src` routing/pages/api, `web/package.json`  
**Goal:** basic duplex voice per session with clear connect/mute/disconnect UX.

Tasks:
- Add `livekit-client` dependency to web app.
- Create voice service module(s), e.g.:
  - `web/src/voice/livekit.ts` (connect/disconnect/publish/subscription wiring)
  - `web/src/voice/types.ts`
- Add UI entry:
  - either new route/page `web/src/pages/VoiceDesk.tsx`
  - or embed in `ChatDesk` with a clearly separated "Voice" panel.
- Flow:
  1. Resolve session id (reuse existing storage pattern from chat).
  2. Request `/v1/session/:sessionId/livekit-token`.
  3. Connect room using returned `wsUrl` + JWT.
  4. If `canPublish`, publish mic track; otherwise subscribe-only mode.
  5. Render remote participant audio and speaking indicators.
- Add robust UI states:
  - permission denied
  - no token / 403
  - disconnected / reconnecting
  - subscribe-only mode banner

Deliverables:
- Working web voice UI and client wiring.
- Basic manual test notes in `web/README.md`.

Blocking deps:
- Requires existing backend route only (already available).

---

## Workstream C - Kerbalizer DSP (send-path processing)
**Owner:** AI-Audio-DSP-1  
**Scope:** new `web/src/audio/*` modules + integration with Workstream B  
**Goal:** "Kerbal voice" effect on outgoing mic before publish.

Tasks:
- Implement audio graph in browser:
  - high-pass filter
  - band-limit / low-pass
  - gentle saturation/waveshaping
  - optional pitch/formant-like character shift
- Preferred architecture:
  - `AudioWorklet` for DSP node(s)
  - fallback mode if worklet unavailable (feature detect + bypass)
- Expose controls:
  - enable/disable effect
  - intensity ("Kerbal strength")
  - wet/dry mix
  - input/output meters (basic RMS/VU)
- Produce a `MediaStreamTrack` for LiveKit local publish from processed stream.
- Include a clean bypass path so users can instantly revert to unprocessed mic.

Deliverables:
- DSP modules + UI controls + integration adapter API consumed by Workstream B.
- CPU/perf note (acceptable browser overhead target).

Blocking deps:
- Needs Workstream B connection layer contract (can proceed using an adapter interface in parallel).

---

## Workstream D - Session/Role UX Alignment
**Owner:** AI-Web-UX-2  
**Scope:** `web/src/pages/ChatDesk.tsx` and/or new shared session UI helpers  
**Goal:** remove friction around session selection and role/publish expectations.

Tasks:
- Add clear session-state panel:
  - current `sessionId`
  - "you are publish-capable / subscribe-only" indicator from token response.
- Add guided actions:
  - "Create session as pilot"
  - "Use dev-shared room"
  - optional "Rotate tower" shortcut for authorized users.
- Improve error copy for common cases:
  - session not found
  - unauthorized for session
  - LiveKit not configured on backend

Deliverables:
- UX polish PR focused on reducing support/debug loops.

Blocking deps: none.

---

## Workstream E - Validation, QA Harness, and Test Matrix
**Owner:** AI-QA-1  
**Scope:** backend + web test docs/scripts (and lightweight automated tests where feasible)  
**Goal:** reproducible verification for voice and Kerbalizer across dev setups.

Tasks:
- Create a concise test matrix doc (dev auth + Clerk auth modes):
  - 2 browsers same machine
  - 2 machines same network
  - publish vs subscribe-only scenarios
  - effect on/off comparison
- Add simple diagnostics checklist:
  - token payload receipt
  - room connection state
  - participant list
  - audio level movement
- Add failure playbook:
  - no mic permission
  - ICE/network issues
  - `LIVEKIT_*` missing
  - wrong session role

Deliverables:
- `VOICE_TEST_PLAN.md` (or section in this file) + any small scripts/helpers.

Blocking deps:
- Best after B/C initial merge, but drafting can start immediately.

---

## Workstream F - Optional KSP Mod Integration (v1 minimal)
**Owner:** AI-KSP-Bridge-1  
**Scope:** KSP plugin/UI files (non-WebRTC)  
**Goal:** expose voice status and quick launch into web desk without in-game DSP/WebRTC complexity.

Tasks:
- Add simple in-mod affordance:
  - show session id
  - show "Voice available in Tower web"
  - provide copy/deep-link action to web voice page (`/voice?session=...`).
- Keep auth boundary in web (no direct LiveKit secret flow in KSP client).
- Do not implement in-game audio capture/playback in this phase.

Deliverables:
- Minimal UX glue only.

Blocking deps:
- Depends on B route/page naming conventions.

---

## 3) Dependency Graph and Execution Order

Start now in parallel:
1. A (Backend hardening)
2. B (Web transport)
3. C (DSP module prototype)
4. D (Session/role UX)
5. E (Test matrix drafting)

Then:
6. Integrate B + C once adapter contract is stable.
7. Run E full test matrix after integration.
8. Optionally run F (KSP minimal bridge) after voice route is finalized.

Critical path:
- B + C integration and publish path verification.

---

## 4) Definition of Done (v1)

Functional:
- Two users in same session can communicate in real time via web voice.
- Backend publish permissions match existing pilot/assigned-tower policy.
- Kerbalizer affects outgoing mic audio and can be toggled off instantly.

Reliability:
- Clear error handling for auth/session/config failures.
- Reconnect and disconnect flows are predictable.

Usability:
- User can see whether they are publish-capable or listen-only.
- Session selection is obvious and persistent.

Documentation:
- Backend and web READMEs document voice setup and dev auth caveats.
- QA matrix exists and is executable by another contributor.

---

## 5) Suggested Delegation Prompts (copy/paste to AIs)

### Prompt for AI-Backend-1
Implement backend hardening for KSCTower LiveKit token flow in `GameData/KSCTowerNetwork/backend`. Keep room naming `tower-${session.id}` and existing policy semantics. Add typed response shape guarantees, better auth decision logging, and dev-mode multi-identity testability without weakening production security. Update `.env.example` + `README.md`, and add tests for publish/subscribe authorization and 503 misconfiguration behavior.

### Prompt for AI-Web-Voice-1
Implement web voice transport in `GameData/KSCTowerNetwork/web` using `livekit-client`. Add a voice UI (new page or ChatDesk section) that reuses existing session-id patterns and backend token API (`POST /v1/session/:sessionId/livekit-token`). Support connect/disconnect, publish if allowed, subscribe-only mode, remote audio rendering, and clear status/error states.

### Prompt for AI-Audio-DSP-1
Build a browser Kerbalizer DSP module for KSCTower web voice send-path. Prefer `AudioWorklet`, include fallback/bypass. Implement high-pass + band-limit + soft saturation + optional pitch/formant-like character effect, with controls for enable, strength, and wet/dry. Expose an adapter that outputs a processed `MediaStreamTrack` suitable for LiveKit local publish.

### Prompt for AI-Web-UX-2
Polish KSCTower web session UX for voice readiness: explicit session state, publish-capable vs subscribe-only indicator, and clearer action buttons for dev-shared/create-session flows. Improve error copy for session/auth/livekit configuration failures. Keep changes focused and non-breaking.

### Prompt for AI-QA-1
Create a KSCTower voice QA plan and validation checklist covering dev-auth and Clerk-auth scenarios, two-browser/two-machine tests, publish permission cases, and Kerbalizer on/off audio validation. Include troubleshooting playbooks for common failure modes.

### Prompt for AI-KSP-Bridge-1 (optional)
Add minimal KSCTower mod integration for voice discovery only: show session id and open/deep-link the web voice desk. Do not implement in-game WebRTC or DSP in v1.

---

## 6) Risk Register

- Dev auth identity collapse (`DEV_OPEN_AUTH`) can hide role/publish bugs unless multi-identity testing is explicit.
- Browser DSP complexity can create CPU spikes; must support quick bypass.
- Echo/feedback risks if device routing is poor; include headset recommendation and mute/PTT defaults.
- Session authorization confusion if users test outside pilot/assigned-tower roles; UI must surface role capabilities.

---

## 7) Fast v1 Milestones

1. **M1 (Transport):** B complete with simple mic publish/subscribe in one session.
2. **M2 (DSP):** C integrated; processed send-path verified by second listener.
3. **M3 (Stability):** A + D merged; errors and role messaging clear.
4. **M4 (Confidence):** E matrix passed in dev environments.
5. **M5 (Optional UX):** F minimal KSP bridge merged.

