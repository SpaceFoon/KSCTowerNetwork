# Globe terrain

`kerbin-stock.png` is the unchanged 8192×4096 KSP color texture from this player's
`GameData/KSCTowerNetwork/PluginData/maps/Kerbin_600000_v4__alt.png` cache.
The plugin extracted it from Kerbin's scaled-space material. See
[`docs/NOTICE.md`](../../../docs/NOTICE.md) for asset provenance.

The other `*-stock.webp` files are native-resolution scaled-space color maps
from the player's KSP 1.12 installation, extracted with UnityPy 1.25.4 and
converted to quality-94 WebP. Asset and texture names/dimensions are recorded
in `stock-sources.json`. Mun uses `MunScaledSpace`; Minmus uses the historical
`NewMunScaledSpace` material. Jool uses its stock `CloudPattern_low` color
map (8192×4096), not the ultra shader's packed control maps.

`*-opm.webp` and `*-opm-ring.webp` come from the
[official Outer Planets Mod](https://github.com/Poodmund/Outer-Planets-Mod),
revision `ffedf02e23d2d620e1018d1467f5e485f7950fa0`.
The 16 color maps retain their native resolutions; rings retain lossless alpha.
DDS color maps are vertically flipped to browser equirectangular convention.
`opm-sources.json` records source names and revision. OPM Eeloo replaces stock
Eeloo only for the OPM catalog. OPM is by CaptRobau/Eudae55 and maintained by
Poodmund; its files/adaptations carry **CC BY-NC-SA 4.0**, with the license in
`OPM-LICENSE.md`.

`*-avp-clouds.webp` are alpha coverage maps from the player's installed
[Astronomer's Visual Pack](https://github.com/themaster402/AstronomersVisualPack),
artwork by Astronomer and maintained by themaster402. The importer flips DDS
orientation, retains coverage, caps it at 4096×2048, and writes lossless WebP.
The shader applies body-specific tints inspired by AVP's Stock/OPM Clouds.cfg;
the web display is a simplified drifting overlay. Shared AVP maps are reused
for the outer atmospheres as assigned in that configuration. Their adaptations
carry **CC BY-NC-SA 4.0**; see `AVP-LICENSE.txt` and `cloud-sources.json`.

`*-marker.webp` are 512×256 previews for the small system overview markers.
Full-resolution maps remain external to JavaScript and load only when a globe
is opened. GPU texture limits may reduce the resolution, which the viewer reports.

A matching live PNG alt layer takes precedence. Bundled maps are guarded by
world ID; a body name alone does not authorize substituting stock geography
for JNSQ, RSS or another pack. These assets have separate rights from the code;
see `docs/NOTICE.md`.

To reproduce imports (Python with Pillow and UnityPy 1.25.4 installed):

```powershell
python scripts/import-globe-textures.py --ksp '<KSP install>' --avp '<GameData/AstronomersVisualPack>' --download-opm
```

Run from `KSCTowerNetwork-dev`. Omit flags to regenerate only the TypeScript
registry and lightweight previews. `--download-opm` explicitly enables network
downloads; the default revision is pinned. The script reads the installation
without changing it. Stock extraction expects KSP 1.12's asset layout, and
Kerbin's existing plugin cache PNG must already be present.
