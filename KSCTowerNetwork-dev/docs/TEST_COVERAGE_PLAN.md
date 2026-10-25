# Test coverage plan — KSCTowerNetwork

This document turns the [review gap analysis](#background) into an ordered roadmap. It complements [`VOICE_IMPLEMENTATION_PLAN.md`](../VOICE_IMPLEMENTATION_PLAN.md) (voice QA matrix) and [`AUDIT.md`](../AUDIT.md) (known foot guns).

## Background

Today:

- **Backend** (`backend/`, `npm test`): broad unit coverage for pure helpers, CSRF, hullcam pipeline, repository slices, scoring, checklists, world inventory/maps, etc., plus narrow HTTP integration tests for messages and craft thumbnails. There is still no broad HTTP-level coverage for `routes/api.ts`.
- **Web** (`web/`, `npm test`): tests for data parsers, hooks, small API/auth/voice helpers. **No page or component tests.**
- **KSP plugin** (`PluginSrc/`): **no** Unity test project; **minimal** `csc` harness for `TowerVoiceListenUiLogic` (helmet ON AIR / BRIDGE rules) under `plugin-tests/`. See [PLUGIN.md → Automated tests](PLUGIN.md#automated-tests-listen-ui-logic).
- **Voice bridge** (`KSCTowerNetwork-voice-bridge/voice-bridge/`): three tracked `node:test` suites cover bridge protocol, LiveKit token errors, and room lifecycle.
- **CI and coverage**: [`.github/workflows/coverage.yml`](../../.github/workflows/coverage.yml) runs backend, web, and bridge coverage on pull requests and pushes to `main`. It publishes LCOV reports as workflow artifacts and attempts the combined JavaScript/TypeScript upload to Codecov from `main` using GitHub OIDC. Codecov currently does not recognize this repository, so that upload is non-blocking until the repository is authorized there. The C# plugin is not included.

## Principles

1. **Highest ROI first:** HTTP contracts + auth + rate limits before UI polish.
2. **Fast and deterministic:** unit tests + narrow integration; mock LiveKit and external SDKs in CI.
3. **Do not block** on flaky E2E (two browsers, real WebRTC, full KSP). Automate what is reliable; keep manual checklists for the rest.
4. **Cross-link tests to docs:** where `AUDIT.md` or `VOICE_IMPLEMENTATION_PLAN.md` names a risk, prefer a test name or comment that points to that item.

---

## Phase 1 — Backend HTTP surface

**Goal:** Regression safety for `backend/src/routes/api.ts` without hand-testing every route.

**Scope:** Representative routes across public, guest, cookie, bearer, and role-gated behavior.

**Approach:**

- Introduce a **test app entry** that does not duplicate production-only side effects: e.g. export `createApp()` from a small module used by `index.ts`, or mount the same router in tests.
- Use **Supertest** (or Node `fetch` against `app.listen(0)` in tests) for request/response assertions.
- Grow a **matrix** incrementally (do not boil the ocean on day one):
  - **Public / health** — routes documented as unauthenticated.
  - **401/403** — missing or invalid auth on a few protected endpoints per pattern (cookie vs bearer).
  - **400/422** — validation failures with stable JSON error shapes.
  - **Idempotent GETs** — caching headers only where specified in [`API_REFERENCE.md`](API_REFERENCE.md).

**Dependencies:** If full routes require MariaDB/Redis, either use **in-memory fallback** when `NODE_ENV=test` (if already supported), or add **Phase 4** infra first for DB-backed tests.

**Exit criteria:** At least one integration file (e.g. `api.integration.test.ts`) runs in `npm test` and covers the top 10–15 highest-traffic or highest-risk endpoints.

---

## Phase 2 — Middleware and configuration

**Goal:** Lock behavior of `middleware/auth.ts`, `middleware/rateLimit.ts`, and `config/env.ts`.

**Scope:**

- **Auth:** bearer extraction, dev bearer secret, cookie session, plugin/JWT paths, Clerk verification branches (mock `@clerk/backend` in tests).
- **Rate limits:** 429 after N hits; exempt routes (e.g. health) stay exempt; optional Redis test URL or mock store.
- **Env:** table-driven tests that invalid production env combinations **fail fast**; `NODE_ENV=test` allows dev/test-only flags per existing rules in [`AGENTS.md`](../AGENTS.md).

**Exit criteria:** Named tests for each **Critical** item in [`AUDIT.md`](../AUDIT.md) that maps to env or auth (or explicit “manual only” with a comment).

---

## Phase 3 — Services and persistence

**Goal:** Cover `guestAuth`, `webAuth`, `pluginAuth`, `registeredUsers`, `inviteCodes`, `store`, `repository` (beyond existing `repository.*.test.ts`), `lib/db.ts`.

**Approach:**

- **Pure logic:** unit tests only (no DB).
- **DB paths:** integration tests with a **throwaway DB**, **migrations applied once**, **transactions rolled back** per test, or **Testcontainers** MariaDB in CI.
- Prefer **vertical slices** (e.g. “invite consumed once”) over mocking every repository method.

**Exit criteria:** At least one integration test for the **most security-sensitive** user-facing flow you maintain (e.g. password change, role grant, or invite redemption).

---

## Phase 4 — LiveKit and voice policy (aligns with voice plan)

**Goal:** Close the gap called out in [`VOICE_IMPLEMENTATION_PLAN.md`](../VOICE_IMPLEMENTATION_PLAN.md): token issuance and publish/subscribe policy are **explicit and testable**.

**Scope:** `services/livekit.ts` + routes that mint tokens, kick, or toggle publish.

**Approach:**

- **Mock** LiveKit server SDK clients so CI never calls real infrastructure.
- Automate: **503** when URL/keys missing; **allowed/denied** publish for role/capability matrix; bridge vs human identity rules consistent with [`AUTH_AND_ROLES.md`](AUTH_AND_ROLES.md).
- Clerk-heavy or multi-tab **dev identity** scenarios may remain **manual**; document them in the voice plan’s QA matrix.

**Exit criteria:** Automated tests cover every row of the **automatable** subset of the voice plan’s matrix; remaining rows listed under “manual” with owner.

---

## Phase 5 — Web app (React)

**Goal:** Protect critical UX paths without maintaining dozens of brittle snapshots.

**Scope:** `web/src/pages/*`, `components/*`, navigation, error states.

**Approach:**

- **Vitest + React Testing Library** for: login flow shell, lobby/room routing, tower page with **mocked fetch** (MSW optional).
- **Defer:** full AudioWorklet / Kerbalizer graphs — keep testing **thin facades** (`audio/*` exports that are pure functions where possible).
- Add **`src/test/setup.tsx`** (or similar) once you have multiple component tests: QueryClient, Router, auth context.

**Exit criteria:** Smoke tests for: unauthenticated redirect or login affordance; one authenticated “happy path” screen per major desk (tower, admin) using mocks.

---

## Phase 6 — KSP plugin (C#)

**Goal:** Pragmatic safety without a full Unity harness.

**Options (pick one tier):**

1. **Low cost:** Maintain a **manual release checklist** (telemetry JSON shape, critical UI opens). Store beside [`PLUGIN.md`](PLUGIN.md).
2. **Medium:** Extract **pure C# helpers** (e.g. JSON builders, string formatting) into a **.NET test project** with **no KSP/Unity references**.
3. **High:** Dedicated harness — only if the team commits ongoing maintenance.

**Exit criteria:** At least tier 1 for every release; tier 2 if any helper regresses often.

---

## Phase 7 — Voice bridge package

**Goal:** Keep protocol, LiveKit token-error, and room-lifecycle behavior covered in the shipping bridge package.

**Current state:** The package has tracked tests in `test/bridgeProtocol.test.ts`, `test/livekitTokenErrors.test.ts`, and `test/roomLifecycle.test.ts`. Its `npm test` command uses Node's built-in test runner.

**Approach:** Add new bridge cases to this package's test tree and use `npm run test:coverage` to generate LCOV from the existing suite.

**Exit criteria:** The tracked bridge tests pass in CI and their source coverage is included in the JavaScript/TypeScript report.

---

## Phase 8 — CI and coverage

**Goal:** Run the existing backend, web, and voice-bridge tests on every pull request and publish measured JavaScript/TypeScript coverage.

**Implementation:** The root [coverage workflow](../../.github/workflows/coverage.yml) runs each package's `npm ci` and `npm run test:coverage`. Backend and bridge use `c8` with the Node test runner; the web app uses Vitest's V8 provider. Each report is retained as a workflow artifact. On pushes to `main`, the workflow attempts a combined `js-ts` upload to Codecov through GitHub OIDC. The upload is non-blocking until Codecov recognizes the repository; no Codecov secret is stored in the repository.

**Coverage scope:** Backend, web, and voice-bridge TypeScript source only. The C# plugin and its small custom test harness are not instrumented. No coverage threshold is enforced yet.

**Exit criteria:** The three test jobs pass and their LCOV artifacts are available from the workflow run. Once the repository is authorized in Codecov, its badge can report the uploaded `js-ts` coverage.

---

## Suggested order of execution

| Order | Phase | Rationale |
|------|--------|-----------|
| 1 | Phase 8 CI and coverage | Run existing tests and publish measured JavaScript/TypeScript coverage |
| 2 | Phase 1 | Largest blind spot |
| 3 | Phase 2 | Auth/env bugs are highest severity |
| 4 | Phase 4 | Matches product risk for voice |
| 5 | Phase 3 | Needs DB story; may parallel Phase 1 if infra ready |
| 6 | Phase 5 | After API contracts stable |
| 7 | Phase 7 | Isolated package |
| 8 | Phase 6 | As time allows |

---

## Metrics (lightweight)

- Track **count** of integration tests for `api.ts` and **list** of endpoints covered; expand quarterly.
- After Phase 2, **zero** open AUDIT items that claim “needs test” without either a test or “won’t fix.”

---

## Related documents

- [`BACKEND.md`](BACKEND.md), [`API_REFERENCE.md`](API_REFERENCE.md), [`AUTH_AND_ROLES.md`](AUTH_AND_ROLES.md)
- [`WEB_SPA.md`](WEB_SPA.md)
- [`PLUGIN.md`](PLUGIN.md)
- [`../AUDIT.md`](../AUDIT.md), [`../VOICE_IMPLEMENTATION_PLAN.md`](../VOICE_IMPLEMENTATION_PLAN.md)
