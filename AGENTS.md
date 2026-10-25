# Repository guidance

Read [the full agent guide](KSCTowerNetwork-dev/docs/AGENTS.md), then [PROJECT_OVERVIEW.md](KSCTowerNetwork-dev/docs/PROJECT_OVERVIEW.md), before changing a subsystem.

Update documentation whenever a change would make it inaccurate. This is a source repository: build outputs, dependency installs, caches, credentials, populated invite stores, and deployment-specific configuration must stay outside Git. See [REPOSITORY_SETUP.md](REPOSITORY_SETUP.md) for migration and publication status.

## Repository and remote workflow

- The canonical repository is [SpaceFoon/KSCTowerNetwork](https://github.com/SpaceFoon/KSCTowerNetwork), with remote `https://github.com/SpaceFoon/KSCTowerNetwork.git`.
- Work from a checkout of that repository. Locate its root with
  `git rev-parse --show-toplevel`; local folder names and absolute paths are
  machine-specific and must not be prescribed in shared documentation.
- Work on and push the `main` branch of that repository. Verify with
  `git remote -v` and `git status --short --branch` before committing or
  pushing.
- `SpaceFoon/ksctower` is the archived legacy repository. Do not push new
  work there, force-push its history into the canonical repository, or treat
  its `master` branch as the active source of truth. If the current checkout
  points to that legacy remote, locate or clone the canonical repository
  before making changes; do not assume a particular local folder location.
- The canonical repository intentionally has fresh Git history. The source
  trees were migrated into it without importing legacy commits or tags.
- Keep unrelated working-tree changes out of a commit. Do not use
  `git add .` when migrating or committing work across these repositories.

Paths in this guide are relative to the repository root. The source layout is
`GameData/`, `KSCTowerNetwork-dev/`, and
`KSCTowerNetwork-voice-bridge/voice-bridge/`. The canonical repository's `main`
branch is authoritative for future development, publication, and deployment.
