# Third-party notices

The root MIT license covers original KSCTowerNetwork code and documentation. It does not replace third-party licenses.

## Earth terrain maps

`KSCTowerNetwork-dev/web/public/maps/_earth_src/world_topo_5layers.svg` is **World topo 5layers**, by **Dbachmann**, made using ETOPO1 data, GMT, and Inkscape. Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:World_topo_5layers.svg). The source offers several licenses; this repository uses [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The three `earth-topo5*-equirect.svg` files are adaptations under CC BY-SA 4.0: longitude/latitude remapping, polar padding, and elevation-band recoloring for the biome and slope proxies. The recolored maps are visual proxies, not measured biome or slope datasets. Keep attribution, this license link, and the description of changes with redistributions. No endorsement is implied.

The flat-color body placeholders and `kerbin-base-schematic.svg` are project-created art. Cached maps sampled from a player's KSP/mod installation are not bundled in this source snapshot.

## LiveKit patch and dependencies

The bridge patch in `KSCTowerNetwork-voice-bridge/voice-bridge/patches/` modifies `@livekit/rtc-node` 0.13.25, distributed by LiveKit under Apache-2.0. The license is preserved in [licenses/LiveKit-Apache-2.0.txt](licenses/LiveKit-Apache-2.0.txt). The upstream archive and extracted staging tree are not included. Dependency manifests and lockfiles remain; retain dependencies' own licenses and notices when packaging installed dependencies.

## Optional material excluded from this snapshot

- Kerbin Aeronautical Charts by alexustas / ASET Aviation Agency: the old manifest identifies CC BY-NC-SA 3.0. PDFs, page images, thumbnails, and the extracted `kerbin-jebbesen-terrain.svg` are excluded. The optional viewer remains with an empty manifest. Numeric navigation supplement data remains in source; its provenance must be reviewed before public release.
- DS-Digital fonts by Dusit Supasawat: excluded. The retained historical `KSCTowerNetwork-dev/fonts/DIGITAL.TXT` describes the author's shareware terms, including distribution and registration conditions; it is not a grant under MIT.
- DSEG7Classic font: excluded because the old runtime tree did not include its accompanying license notice.
- Unused Wikimedia biome and climate reference SVGs: excluded. Only the attributed topo source and its derivatives remain.

## Player-installed mods and KSP

KSP assemblies and other mods are not distributed here. Live navaids, world inventory, and terrain are read from the player's installation. Their source licenses are not replaced by this project's MIT license.
