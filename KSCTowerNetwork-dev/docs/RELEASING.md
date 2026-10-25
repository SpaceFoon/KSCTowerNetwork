# Building and publishing a release

One GitHub Release contains two downloads, an external CKAN metadata file and
SHA256SUMS.txt. The client is Windows x64; the server installs on Linux or Windows
with Node 24.22.1+ (24.x), npm, MariaDB, Redis, an HTTPS proxy and LiveKit.

- **Client ZIP:** compiled KSP plugin, Windows Node runtime, patched LiveKit bridge,
  runtime dependencies, settings template, install guide and license notices.
  Pilots enter their operator's server address in the in-game Tower login
  window; the client remembers it. No community server is implied. Controllers only need the operator's website.
- **Server ZIP:** compiled backend and same-origin website, package lockfile,
  deployment templates, docs and optional chart installer. No Windows native
  dependencies are copied to Linux. Run the server install command on the host.
- **KSCTowerNetwork.ckan:** generated after the client ZIP, with its final size,
  URL and hashes. Keep it beside the ZIP; embedding a hash of an archive inside
  itself creates an impossible circular checksum requirement.

Rebuild and publish a new Client ZIP to distribute the Server address login
field. Previously published clients do not gain this UI from a backend update.

## Maintainer build (Windows x64)

Use the canonical SpaceFoon/KSCTowerNetwork checkout and a clean committed main.
Close KSP. Set matching versions in PluginSrc/Properties/AssemblyInfo.cs and
GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version.
The current package version is 1.0.1. Assembly and AVC versions must match; the builder regenerates the released CKAN version, download size and hashes.

From KSCTowerNetwork-dev (substitute actual paths):

```powershell
& 'C:/path/to/Node24/node.exe' scripts/package-release.mjs --ksp-managed 'C:/path/to/KSP/KSP_x64_Data/Managed'
```

Node must have npm and LICENSE alongside it. The existing bridge
scripts/package-release.ps1 delegates to this builder; it now builds both
packages and takes -KspManagedPath, -Version, -NodeExePath and -OutputDirectory.
Deployment-specific -ConfigPath is no longer used for public releases.

The builder copies only Git-tracked source into a new ignored release directory,
installs locked dependencies, runs backend/web/bridge tests, server/release tests,
voice/ACARS invariant checks, plugin pure tests, and fresh builds. It uses no -Dev
plugin define. It retains upstream licenses, applies the LiveKit crash guards,
checks archive staging for private files and excluded optional assets, and emits
manifests tying both packages to the source commit. Existing release folders and
the maintainer's local GameData settings/runtime are not overwritten.

Outputs under release/1.0.1-<unique>/:

- KSCTowerNetwork-Client-1.0.1-win-x64.zip
- KSCTowerNetwork-Server-1.0.1.zip
- KSCTowerNetwork.ckan
- SHA256SUMS.txt

Source/build staging folders are diagnostic only; upload just those four files.
Verify ZIP contents and SHA256 sums after extraction, install server dependencies
on the target OS, check production startup guards and health/login, and test KSP
pairing, telemetry and two-participant voice before calling a release stable.
Build/test success does not establish live KSP, Linux provisioning or LiveKit
acceptance. Use a GitHub prerelease while those checks remain outstanding.

## Publish

Push the tested source commit to canonical main. Create tag v1.0.1 at that exact
commit, create a GitHub Release, attach the four outputs and explain client/server
installation and verification limits. Do not upload source/build staging, local
configuration, KSP assemblies, chart bundles, fonts or player game textures.
Do not overwrite an existing published tag or release: use a new patch version.

CKAN catalog publication is a separate NetKAN submission and dependency review.
The NetKAN metadata selects only Client ZIPs via the $kref /asset_match/ suffix; the server ZIP is never a mod install.
No automatic catalog inclusion is claimed by merely publishing GitHub assets.

The checked-in standalone .ckan now describes the actual v1.0.0 Client ZIP;
its corrected dependency IDs differ from the immutable release's original .ckan
asset. Future builds regenerate download fields. See [CKAN validation](../ckan/README.md).

## v1.0.1 client update

Pilots can enter and save the operator's server address in Tower login. Log out
and reopen the window to switch servers. The optional separate web desk address
supports split website/API deployments. The bundled bridge follows the chosen
server; existing operators do not need a server upgrade solely for this UI.

The release pipeline includes 37 address checks and 31 checks using the real KSP
ConfigNode save/load parser. Live KSP pairing, telemetry and two-participant voice
acceptance remain outstanding, so this version is published as a prerelease.
