# New repository setup

Prepared on October 4, 2026, from the tracked working files in the previous `SpaceFoon/ksctower` checkout. This repository has a new initial commit and no imported Git history. The old checkout and its history remain separate.

## Snapshot changes

- Added root README, MIT LICENSE, agent guidance, and third-party notices.
- Excluded compiled DLLs, `obj/`, compiled bridge runtime app files, crash logs, and LiveKit scratch packaging.
- Excluded the populated invite-code store. A missing store starts empty. Runtime invite/user stores, auth, and deployment configuration are ignored.
- Replaced the tracked runtime `settings.cfg` with the local template. Per-install settings are ignored; edit `settings.example.cfg` for shared defaults.
- Excluded optional charts, fonts, cached game maps, and unused third-party reference maps. The Charts viewer displays an explicit unavailable state until an operator installs a valid chart bundle locally.
- Retained the active bridge patch and its upstream Apache-2.0 license. Build release binaries from source and carry dependency notices into releases.

## Before opening the repository publicly

1. Revoke the previously tracked invite through the owner UI on every running deployment that loaded it. Removing it from this snapshot does not revoke a code in a running service or another installation.
2. Review retained navigation data and any further third-party provenance questions. Private hosting alone does not settle licensing.
3. Review the committed snapshot for secrets and personal data. The migration's pattern scan is not a comprehensive secret audit. The old repository/history needs its own review and cleanup if it will be made public.
4. Verify plugin builds against KSP, bridge builds, and a packaged release. Snapshot hygiene checks are not proof of runtime or production readiness.

## GitHub

Create `SpaceFoon/KSCTowerNetwork` as **private** and connect it as `origin`. Push only this repository's `main` branch, not the old repository's branches or tags. The original checkout still points to its existing remote.

## Validation of the initial snapshot

- Web production build passed (Vite reports existing large bundle warnings).
- Static voice and ACARS invariant checks passed.
- Web TypeScript checking reports the same 21 diagnostics as the original checkout; none is in ChartsPage.tsx. These baseline errors remain open.
- Source hygiene and the previously tracked invite-value exclusion were checked before the initial commit.
- No KSP runtime, C# plugin build, full test suite, or production deployment was verified during this repository migration.
