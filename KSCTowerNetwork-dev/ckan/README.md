# CKAN metadata

CKAN installs the Windows x64 client only. Server operators use the separate
Server ZIP and [SERVER_HOSTING.md](../docs/SERVER_HOSTING.md). This repository
has not been submitted to the CKAN catalog.

| File | Purpose |
| --- | --- |
| KSCTowerNetwork.netkan | Submission metadata that selects Client ZIPs from GitHub releases and reads the bundled AVC version file. |
| KSCTowerNetwork.ckan | Standalone metadata for the published v1.0.1 Client ZIP, with its actual URL, byte size, SHA1 and SHA256. The release builder also uses this as a base and regenerates download fields for future releases. |
| ../../GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version | Shipped version, KSP compatibility bounds and AVC update URL. |

The GitHub asset regex is part of `$kref` via `/asset_match/<regex>`.
The previous top-level `x_netkan_asset_match` field was ignored by NetKAN.
The selector matches the Client ZIP only; it excludes the Server ZIP, GitHub's
automatic source archives, CKAN metadata and checksums.

GitHub prerelease filtering is not restricted: NetKAN's documented default is
to consider both prereleases and regular releases. The existing prerelease
retains `release_status: testing`. Review this status when preparing a stable
release; do not claim in-game acceptance based on schema validation.

## Verified relationship identifiers

Catalog records were checked on October 25, 2026, at
[CKAN-meta e183fb5](https://github.com/KSP-CKAN/CKAN-meta/tree/e183fb554636aedb95cd00da272013378b4fa1bc).
All 17 identifiers below have matching actual metadata records; directory names
alone were not treated as sufficient evidence.

| Relationship | Exact catalog identifiers |
| --- | --- |
| depends | ModuleManager |
| recommends | ClickThroughBlocker, RasterPropMonitor, ASETProps, ASETAvionics, AvionicsSystems, kOS, HullcamVDSContinued, JustReadTheInstructions |
| suggests | KSAIVAUpgrade, Reviva, FreeIva, kOSPropMonitor, VesselView, DE-IVAExtension, Kerbalism, Chatterer |

`ASET-Props` and `ASET-Avionics` were incorrect identifiers and have been
replaced with `ASETProps` and `ASETAvionics` in both files. Existing
relationship strengths were retained. Checking names does not establish that
every optional mod/version combination is compatible with every supported KSP
version; CKAN installation and runtime checks remain separate work.

## Validation evidence and limits

Both files were validated against the official draft-04
[NetKAN.schema](https://github.com/KSP-CKAN/CKAN/blob/c0650d4502b1aa718d6cb1cf68fa7ec1d7fd678b/NetKAN.schema)
and [CKAN.schema](https://github.com/KSP-CKAN/CKAN/blob/c0650d4502b1aa718d6cb1cf68fa7ec1d7fd678b/CKAN.schema)
at CKAN commit `c0650d4`, with format checks enabled. The GitHub selector
was checked against actual release assets and negative Server/source/archive
cases. The standalone metadata's size and hashes were checked against the local
client ZIP and GitHub's published SHA256 digest. No project dependency changes
are needed for this metadata correction.

The original v1.0.0 GitHub release is immutable. Its uploaded .ckan asset still
contains the old relationship identifiers; the corrected standalone metadata
is this repository file. Published ZIPs, their tag and checksums were not changed.
The v1.0.1 release includes corrected metadata; the v1.0.0 release is preserved.

Remaining work: review Windows executable/native-library packaging, run NetKAN
inflation and a clean CKAN installation, verify live KSP/voice behavior, then
submit a pull request adding the .netkan file under NetKAN/ in
[KSP-CKAN/NetKAN](https://github.com/KSP-CKAN/NetKAN), following the
[official submission guide](https://github.com/KSP-CKAN/CKAN/wiki/Adding-a-mod-to-the-CKAN).
No catalog submission or CKAN installation was performed by this metadata check.

## Future releases

Follow [RELEASING.md](../docs/RELEASING.md). Keep the assembly version and AVC
version aligned, and check KSP bounds against versions actually tested. The
builder produces external .ckan metadata after the Client ZIP, filling its final
URL, size and hashes. Do not embed an archive's own checksum inside that archive.
Recheck dependency records and schema changes before submission. After a NetKAN
submission is accepted, the indexing service can process matching releases;
catalog updates still depend on successful validation and inflation.
