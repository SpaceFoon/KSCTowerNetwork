# Third-party notices

See the [canonical repository notices](../../NOTICE.md) for Earth terrain, LiveKit, retained navigation data, excluded fonts and player-installed mods. Optional Kerbin charts are downloaded and installed by the server owner; see [installation and attribution](AEROCHART_REFERENCE.md). Third-party chart bundles are not included in this repository.

## Kerbin globe texture — `web/public/globes/kerbin-stock.png`

This 8192×4096 PNG was copied unchanged from the player's plugin cache,
`GameData/KSCTowerNetwork/PluginData/maps/Kerbin_600000_v4__alt.png`.
`TowerBasemapBaker` extracts the scaled-space color texture from the player's
Kerbal Space Program installation. The geography and terrain artwork are KSP
game assets belonging to their respective rights holders, not MIT-licensed
KSCTowerNetwork artwork. The globe renderer itself is KSCTowerNetwork code.

## Stock and OPM globe surfaces, rings and AVP clouds — `web/public/globes/`

Stock `*-stock.webp` color maps are extracted from the player's KSP 1.12
scaled-space materials. They retain native dimensions and are converted to
quality-94 WebP; their names and Unity source files are in `stock-sources.json`.
They are KSP artwork under the game's rights, not MIT code.

OPM `*-opm.webp` surfaces and `*-opm-ring.webp` ring maps are from
[Outer Planets Mod](https://github.com/Poodmund/Outer-Planets-Mod) by
CaptRobau/Eudae55, maintained by Poodmund, at revision
`ffedf02e23d2d620e1018d1467f5e485f7950fa0` (see `opm-sources.json`).
Color maps are vertically flipped and converted to WebP; ring alpha is lossless.
These adaptations remain under **CC BY-NC-SA 4.0**; the full upstream license
is bundled in `OPM-LICENSE.md`.

AVP `*-avp-clouds.webp` coverage maps are derived from the player's installed
[Astronomer's Visual Pack](https://github.com/themaster402/AstronomersVisualPack),
artwork by Astronomer, maintained by themaster402. The importer flips orientation,
extracts alpha, caps coverage at 4096×2048 and encodes lossless WebP; original
names and dimensions are in `cloud-sources.json`. These adaptations remain
under **CC BY-NC-SA 4.0**, with the full license in `AVP-LICENSE.txt`.
The separate lightweight `*-marker.webp` previews inherit the corresponding
surface's rights. The WebGL renderer and import script remain MIT code.


The textures described above are optional local imports, excluded from Git.
This source repository retains the renderer, importer, source manifests and
license notices; it does not distribute KSP, OPM or AVP image files.
