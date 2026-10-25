# New repository setup

Prepared on October 4, 2026, from the tracked working files in the previous `SpaceFoon/ksctower` checkout. This repository has a new initial commit and no imported Git history. The old checkout and its history remain separate.

## Snapshot changes

- Added root README, MIT LICENSE, agent guidance, and third-party notices.
- Excluded compiled DLLs, `obj/`, compiled bridge runtime app files, crash logs, and LiveKit scratch packaging.
- Excluded the populated invite-code store. A missing store starts empty. Runtime invite/user stores, auth, and deployment configuration are ignored.
- Replaced the tracked runtime `settings.cfg` with the local template. Per-install settings are ignored; edit `settings.example.cfg` for shared defaults.
- Chart PDFs, all rendered pages, extracted transcripts/reference data, and the terrain SVG are excluded. The optional local installer generates a server-owned bundle from an upstream PDF downloaded separately. Fonts and cached game maps remain excluded. See KSCTowerNetwork-dev/docs/AEROCHART_REFERENCE.md.
- Retained the active bridge patch and its upstream Apache-2.0 license. Build release binaries from source and carry dependency notices into releases.

## Before opening the repository publicly

1. Revoke the previously tracked invite through the owner UI on every running deployment that loaded it. Removing it from this snapshot does not revoke a code in a running service or another installation.
2. Review retained navigation data and any further third-party provenance questions. Private hosting alone does not settle licensing.
3. Review the committed snapshot for secrets and personal data. The migration's pattern scan is not a comprehensive secret audit. The old repository/history needs its own review and cleanup if it will be made public.
4. Verify plugin builds against KSP, bridge builds, and a packaged release. Snapshot hygiene checks are not proof of runtime or production readiness.

## Flightwall source transfer - October 10, 2026

The flightwall feature and its site-color/sweep-decay fixes from old-checkout
commits `4111ac8`, `005642a` and `530e69b` were transferred into this repository
as source changes, without importing old Git history or compiled DLLs. The
public checkout's newer radar TypeScript fix was retained.

Validation: strict web typecheck and production build, 18 focused web tests,
backend typecheck, two thumbnail HTTP integration tests, C# thumbnail path
tests, and plugin compilation against installed KSP references passed. This
does not establish in-game thumbnail relay or deployment readiness.

## GitHub

The fresh repository points to `SpaceFoon/KSCTowerNetwork` as `origin`. GitHub visibility was verified as **private** on October 10, 2026; public publication is a separate step. Push only this repository's `main` branch, not the old repository's branches or tags. The original checkout still points to its existing remote.

## Validation of the initial snapshot

- Web production build passed (Vite reports existing large bundle warnings).
- Static voice and ACARS invariant checks passed.
- Web TypeScript checking reports the same 21 diagnostics as the original checkout; none is in ChartsPage.tsx. These baseline errors remain open.
- Source hygiene and the previously tracked invite-value exclusion were checked before the initial commit.
- No KSP runtime, C# plugin build, full test suite, or production deployment was verified during this repository migration.

## Optional chart installation verification - October 10, 2026

The previously unpublished chart-bundle commit was replaced before publication. No third-party chart PDF, rendered pages, transcripts/reference-data bundle, or extracted terrain SVG is in the publishable branch history. The original local files were preserved outside this checkout.

The local installer was exercised against the owner-held source PDF: 22 rendered pages and thumbnails, 68 printed navaid rows, matching transcripts and SHA256; existing-bundle overwrite was refused. The web production build and two source-only chart search tests passed. Desktop/mobile isolated ChartsPage browser checks covered the empty installation links and generated assets/search with no page errors or failed requests. This is component evidence, not a full authenticated backend/KSP session. The web TypeScript check still reports 21 baseline diagnostics outside the changed chart code. Invite revocation, comprehensive secrets review and runtime/release validation remain separate publication gates.

PowerShell and Bash chart-install wrappers were verified end to end on October 10, 2026 in Windows PowerShell and Git Bash, with spaces in PDF/output paths. Each generated 22 pages and matching attribution. Linux/macOS execution was not directly tested. Bash files use LF checkout endings; wrapper dependencies remain in the ignored web/.chart-tools environment.

## Local checkout relocation - October 10, 2026

The new checkout was moved out of `ksctower/.new-repo/KSCTowerNetwork` into
its sibling folder `KSCTowerNetwork`. The original `ksctower` checkout and
its history remain available as the legacy repository. Git integrity and
remaining-file comparison passed before the nested checkout remnants were
removed. This records a historical local migration, not a required checkout
location. For future development, use a checkout of
[SpaceFoon/KSCTowerNetwork](https://github.com/SpaceFoon/KSCTowerNetwork);
verify its Git remote rather than relying on its local folder name.

Local backend/web `.env.development` files were copied from the legacy
checkout; plugin settings were merged with its personal settings, and its
invite store was retained. Existing new-checkout configuration is backed up
in the ignored `.local-migration-backup-20261010/` folder. Local fonts and
cached game maps were copied into their ignored runtime locations. The
owner-held optional chart PDF was copied into ignored `.local-assets/`, and
the installer generated 22 chart pages in `web/dist/charts/`. These local
files are outside Git and do not accompany a public clone.

Backend and web builds, 110 web regression tests, 13 bridge tests, voice and
ACARS invariant checks, and plugin compilation against installed KSP
assemblies passed after relocation. The plugin compiler now uses a response
file so quoted paths work in Windows PowerShell and PowerShell 7. Owner login,
lobby navigation and the installed Charts route were verified in Edge against
the actual local backend, with no page errors or failed responses. Migrated
LiveKit credentials passed a read-only room-listing request.

During this check Windows rejected bindings on default web/voice ports
45173/47372/47373 with EADDRINUSE despite no matching listener in netstat.
The cause was WSL mirrored networking reserving Linux ephemeral ports
44620–48715. An ignored `KSCTowerNetwork-dev/dev-ports.local.json` now selects
web 48800 and bridge TCP 48801/48802 for ordinary `npm run dev`; backend
remains on 48787. The checkout plugin settings match these voice ports.
Normal startup, owner login and lobby navigation passed after this fix,
with no browser page errors or failed responses; 110 web tests passed.
A live KSP voice/telemetry session must still pass before archiving the legacy repo.
The game installation was not overwritten by this source-checkout move.

Backend tests now preload isolated settings before imports and skip personal dotenv files. The standard test run covers 240 tests, with four optional tests skipped. Its cleanup hook releases database/Redis clients in each test child. Production JWT guards remain enforced.

See `KSCTowerNetwork-dev/docs/DEVELOPMENT.md` for standalone-checkout builds
and local verification commands. Reinstall optional charts after each web
build, which clears `web/dist/`.
## Legacy globe restoration - October 10, 2026

The fresh-history snapshot predated the legacy repository's later solar-system
artwork and rotating WebGL globes. The renderer, inspector, starfield, texture
registry, importer and preview were restored from the legacy checkout. Existing
local stock KSP, OPM and AVP images were copied into ignored `web/public/globes/`
with their provenance and license notices. These images do not accompany a clone;
see `KSCTowerNetwork-dev/docs/WEB_SPA.md` for optional local imports.

The final legacy source comparison and restored wall-map/session-globe connections are recorded in [the migration parity audit](KSCTowerNetwork-dev/docs/MIGRATION_PARITY.md). No further missing feature code was found; real in-game voice/telemetry validation remains outstanding.
