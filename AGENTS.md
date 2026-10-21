# Repository guidance

Read [the full agent guide](KSCTowerNetwork-dev/docs/AGENTS.md), then [PROJECT_OVERVIEW.md](KSCTowerNetwork-dev/docs/PROJECT_OVERVIEW.md), before changing a subsystem.

Update documentation whenever a change would make it inaccurate. This is a source repository: build outputs, dependency installs, caches, credentials, populated invite stores, and deployment-specific configuration must stay outside Git. See [REPOSITORY_SETUP.md](REPOSITORY_SETUP.md) for migration and publication status.

## Repository and remote workflow

- The active checkout is `C:\Users\Darren\Documents\GitHub\KSCTowerNetwork`.
- Its canonical remote is `https://github.com/SpaceFoon/KSCTowerNetwork.git`.
- Work on and push the `main` branch of that repository. Verify with
  `git remote -v` and `git status --short --branch` before committing or
  pushing.
- `C:\Users\Darren\Documents\GitHub\ksctower` is the archived legacy
  checkout, with the old `https://github.com/SpaceFoon/ksctower.git` remote.
  Do not push new work there, force-push its history into the new repository,
  or treat its `master` branch as the active source of truth.
- The new repository intentionally has fresh Git history. The source trees
  were migrated into it without importing the legacy repository's commits or
  tags. If an agent starts in the legacy checkout, stop and switch to the
  sibling `KSCTowerNetwork` checkout before making changes.
- Keep unrelated working-tree changes in the active checkout out of a commit.
  Do not use `git add .` when migrating or committing work across these two
  repositories.

The repository layout is intentionally shared between the two checkouts:
`GameData/`, `KSCTowerNetwork-dev/`, and
`KSCTowerNetwork-voice-bridge/voice-bridge/`. Only the new checkout's `main`
branch is authoritative for future development, publication, and deployment.
