# KSCTowerNetwork — `docs/`

Per-subsystem reference. Pair with the higher-level
[`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) (architecture + file inventory)
and the AI-facing [`AGENTS.md`](AGENTS.md) (rules + quick orientation). Plan
documents (`*_PLAN.md`) live alongside this file and capture **future** intent;
the rest of the docs in this folder describe **current** behavior of code that
already exists.

| If you're trying to… | Read |
|---|---|
| Understand the moving parts and how data flows | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Ports / firewall / UDP+WS live transport | [`ARCHITECTURE.md` → Ports…](ARCHITECTURE.md#ports-firewall-and-live-transport) |
| Hot HTTP routes, profiling, live metrics | [`PERFORMANCE_AND_HOT_PATHS.md`](PERFORMANCE_AND_HOT_PATHS.md) |
| Work on the backend service | [`BACKEND.md`](BACKEND.md) |
| Tower derivation rules (approach, separation, violations, …) | [`TOWER_LOGIC.md`](TOWER_LOGIC.md) |
| Work on the React web app | [`WEB_SPA.md`](WEB_SPA.md) |
| Work on the C# KSP plugin | [`PLUGIN.md`](PLUGIN.md) |
| Cockpit radio MHz / VOL / 25 kHz COM | [`TOWER_RADIO_UI.md`](TOWER_RADIO_UI.md) |
| Work on the voice bridge | [`VOICE_BRIDGE.md`](VOICE_BRIDGE.md) |
| Look up an HTTP endpoint | [`API_REFERENCE.md`](API_REFERENCE.md) |
| Add or change auth / roles / capabilities | [`AUTH_AND_ROLES.md`](AUTH_AND_ROLES.md) |
| Configure a setting or env var | [`SETTINGS_REFERENCE.md`](SETTINGS_REFERENCE.md) |
| Get a dev environment running | [`DEVELOPMENT.md`](DEVELOPMENT.md) |
| Run the server on a Linux VPS or Windows host | [`SERVER_HOSTING.md`](SERVER_HOSTING.md) |
| Build and publish client/server ZIPs | [`RELEASING.md`](RELEASING.md) |
| Deploy to production / a community server | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Diagnose a specific failure mode | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| Roadmap automated tests (HTTP, auth, web, CI) | [`TEST_COVERAGE_PLAN.md`](TEST_COVERAGE_PLAN.md) |
| Decode a term or acronym | [`GLOSSARY.md`](GLOSSARY.md) |
| Live internet radio / stream stations (not shipped) | [`RADIO_LIVE_STREAMS.md`](RADIO_LIVE_STREAMS.md) |
| Know which other mods we play with, why, and which are required | [`INTEGRATIONS.md`](INTEGRATIONS.md) — player-facing, mirrors the CKAN dependency list |
| Install optional chart PDF and searchable pages | [`AEROCHART_REFERENCE.md`](AEROCHART_REFERENCE.md) |
| Kerbin navaid / aerodrome supplement (operational values; optional charts installed separately) | [`web/src/data/kerbinAeroCharts.ts`](../web/src/data/kerbinAeroCharts.ts) (with `kerbinNavaids.ts` for lat/lon) |

## Plan documents (future / in-flight work)

These live alongside this file under `docs/`. They're proposals for work not
yet shipped — don't treat them as current behavior.

- [`REAL_TOWER_ROADMAP.md`](REAL_TOWER_ROADMAP.md)
- [`ROLEPLAY_FEATURES_CATALOG.md`](ROLEPLAY_FEATURES_CATALOG.md)
- [`IDENTITY_PLAN.md`](IDENTITY_PLAN.md)
- [`PER_FREQUENCY_CHANNELS_PLAN.md`](PER_FREQUENCY_CHANNELS_PLAN.md)
- [`GHOSTS_AND_TOWER_VIEW_PLAN.md`](GHOSTS_AND_TOWER_VIEW_PLAN.md)
- [`TELEMETRY_AND_TOWER_TRACKING_PLAN.md`](TELEMETRY_AND_TOWER_TRACKING_PLAN.md)
- [`VOICE_IMPLEMENTATION_PLAN.md`](VOICE_IMPLEMENTATION_PLAN.md)
- [`ATIS_PLAN.md`](ATIS_PLAN.md)
- [`AUDIT.md`](AUDIT.md) — known reliability/security issues

## Conventions used in these docs

- Paths are workspace-relative unless noted (e.g. `backend/src/index.ts`
  means `KSCTowerNetwork-dev/backend/src/index.ts`).
- "Tower" and "controller" are interchangeable in UI copy. Internally the
  role identifier is `controller`.
- Default ports: backend **`48787`**, web dev server **`45173`**, optional
  local-development UDP **`48788`** (disabled by default), bridge PCM
  **`47372`**, bridge control **`47373`**.
- "Bridge" without qualification means the **voice bridge** Node process,
  not any other kind of bridge.

Optional chart download, installation, source export and search: [AEROCHART_REFERENCE.md](AEROCHART_REFERENCE.md).
