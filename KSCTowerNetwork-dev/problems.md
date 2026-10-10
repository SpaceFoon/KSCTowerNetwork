# KSCTowerNetwork — repository problems (snapshot)

Last reviewed: 2026-04-22. Regenerate or edit this file when the codebase changes materially.

## Builds and tests

- **Backend:** `npm run typecheck` and `npm test` both succeed (83 tests at last check; re-run to confirm if you've added more).
- **Web:** `npm run build` succeeds; Vite warns about very large chunks (~6 MB JS) — performance/maintenance concern, not a hard failure.

## Documentation drift

- ~~`docs/README.md` points at `../PROJECT_OVERVIEW.md`, `../AGENTS.md`, and `../REAL_TOWER_ROADMAP.md` (and similar). Those files now live beside it in `docs/`, so those links 404.~~ **Fixed 2026-04-22:** all `../` links rewritten to sibling paths under `docs/`.
- ~~`docs/AGENTS.md` links like `[ARCHITECTURE.md](docs/ARCHITECTURE.md)` resolve to `docs/docs/...`.~~ **Fixed 2026-04-22:** `docs/` prefix dropped (file is already inside `docs/`).
- ~~`TEST_COVERAGE_PLAN.md` is referenced in `docs/AGENTS.md` but no such file exists.~~ **Fixed 2026-04-22:** `KSCTowerNetwork-dev/TEST_COVERAGE_PLAN.md` (root pointer) and `docs/TEST_COVERAGE_PLAN.md` (canonical) both exist; links resolve.
- ~~`docs/AUDIT.md` is partly out of date on **C1**, **C2**, and **H-B6**.~~ **Refreshed 2026-04-22:** those three are now marked **[FIXED]** with current line references; the rest of the audit still needs item-by-item re-validation.

## Security / reliability (still worth tracking)

From the audit and spot-checks, these **remain plausible** until proven fixed in code:

- **Concurrency / data races** (e.g. tower assignment, `H-B1`), **ban/mute keying** (`H-B3`), **plugin exchange-code collision** (`H-B2`), **lobby enumeration** (`H-B5`), **JWT `algorithms`** (`M-B1`), **voice bridge** reconnect / buffer / ordering (`H-V1`, `M-V2`–`M-V4`) — still open per `docs/AUDIT.md`.
- **Plugin:** synchronous TCP / threading / token storage concerns (`H-P1`–`H-P3`, `M-P*`) are still open; not re-validated line-by-line in the last pass.
- Frontend leaks on disconnect/unmount (`H-F1`, `H-F2`) and the LiveKit caps race (`H-F3`) need re-checking against current `RoomPage.tsx` / `VoiceDesk.tsx` line numbers.

## Repo hygiene

- ~~`voice-bridge-tmp/` under `KSCTowerNetwork-dev` is scratch packaging and not in `.gitignore`.~~ **Fixed 2026-04-22:** added `KSCTowerNetwork-dev/voice-bridge-tmp/` to the root `.gitignore`. (Existing tracked files, if any, would still need `git rm --cached`.)
- **Optional Kerbin aerocharts** — third-party PDF/pages/transcripts and terrain SVG are excluded. Server owners install separately using `docs/AEROCHART_REFERENCE.md`; generated adaptations retain their source license.
- **Tracked `node_modules`** under `GameData/.../bridge-runtime/` is intentional per the `.gitignore` notes, but it bloats the repo and is unusual; be careful with upgrades and licensing.

## Summary

| Area | Status |
|------|--------|
| TS/web compile | OK |
| Doc links / `TEST_COVERAGE_PLAN` | Fixed |
| `AUDIT.md` vs current auth/CORS | C1/C2/H-B6 marked fixed; rest still needs validation |
| `voice-bridge-tmp/` ignore | Fixed |
| Deeper backend/plugin/bridge issues | Still follow `docs/AUDIT.md` with verification |

## Suggested follow-ups

1. ~~Repair `docs/README.md` and `docs/AGENTS.md` links (and either add `TEST_COVERAGE_PLAN.md` or remove references).~~ Done 2026-04-22.
2. ~~Refresh `docs/AUDIT.md` for items already fixed.~~ Partial: C1, C2, H-B6 done. **Remaining:** re-validate all `H-*`, `M-*`, and `L-*` items against current line numbers and either annotate `[FIXED]` or update the file paths.
3. Investigate the ~6 MB Vite chunk warning — at minimum split LiveKit + heavy map client code into async chunks.
