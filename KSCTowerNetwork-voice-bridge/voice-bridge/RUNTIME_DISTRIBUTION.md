# Bundled voice bridge runtime

The current release recipe is [RELEASING.md](../../KSCTowerNetwork-dev/docs/RELEASING.md).
It builds both Client and Server ZIPs from a clean committed source tree.

## Client runtime layout

GameData/KSCTowerNetwork/PluginData/bridge-runtime contains:

- start-bridge.cmd: plugin launcher with local defaults; the plugin passes the configured backend and session.
- node/node.exe and node/LICENSE: portable Windows x64 Node 24 runtime and its third-party licenses.
- app/dist/bridge.js: freshly compiled bridge.
- app/package.json, package-lock.json and node_modules: locked production dependencies, including LiveKit's native Windows runtime.

The client archive also includes root install instructions, MIT license, project
notices, dependency notices and a SHA256 file manifest. KSP and other mods are
not bundled. Pilots configure their operator's server in settings.cfg; public
releases do not embed a maintainer's deployment or login credentials.

## Local bridge build

With Node and npm installed side by side:

```powershell
npm ci
.\scripts\build-bridge-runtime.ps1 -NodeExePath 'C:/path/to/Node24/node.exe'
```

The script rebuilds the bridge, stages production dependencies, checks and overlays
the local LiveKit FFI crash guards, and bundles Node. Its output replaces the
checkout runtime directory. The public release builder runs this inside isolated
tracked-source staging so personal settings and optional game assets stay out.
The maintainer's installed KSP directory is used only for compiler references.

## Acceptance

Check a clean client installation with a real operator: login/pairing, telemetry,
remote voice playback, browser microphone/PTT and bridge exit after quitting KSP.
Run voice with two participants. Compilation, unit tests and native import checks
do not establish in-game acceptance. Mark releases as prereleases until these
checks pass. Controllers use the hosted website and install no bridge.
