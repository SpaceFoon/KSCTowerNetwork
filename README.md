# KSCTowerNetwork

Voice, telemetry, ACARS text, and controller tools for Kerbal Space Program. Pilots run KSP with the plugin; controllers use the web app. Each player keeps their own physics and save.

This source repository starts with a fresh history. Keep the GitHub repository **private** until the publication checklist in [REPOSITORY_SETUP.md](REPOSITORY_SETUP.md) has been completed.

| Directory | Contents |
| --- | --- |
| `KSCTowerNetwork-dev/` | C# plugin source, TypeScript backend, React web app, build scripts, and docs |
| `KSCTowerNetwork-voice-bridge/voice-bridge/` | Active voice bridge source, tests, patches, and runtime/release builders |
| `GameData/KSCTowerNetwork/` | Runtime templates, ModuleManager patches, IVA props, and kOS scripts |

Start with [Development](KSCTowerNetwork-dev/docs/DEVELOPMENT.md), [Project overview](KSCTowerNetwork-dev/docs/PROJECT_OVERVIEW.md), and the [documentation index](KSCTowerNetwork-dev/docs/README.md). Plugin builds require a local KSP installation. Compiled plugin DLLs, the portable Node runtime, and compiled bridge files are generated locally and belong in releases.

Project code is under the [MIT license](LICENSE). Third-party material has separate terms in [NOTICE.md](NOTICE.md). Optional Kerbin Aeronautical Charts and their generated adaptations retain CC BY-NC-SA 3.0 and are downloaded separately. Chart bundles and font binaries are excluded.

The web app's `/charts` route explains how to install optional charts; once installed it provides full-document search, original PDF access, and downloadable reference data. See [chart download and installation](KSCTowerNetwork-dev/docs/AEROCHART_REFERENCE.md).
