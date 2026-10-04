"""Build the Earth equirectangular basemap layer SVGs from Wikimedia's "World topo 5layers".

The source is a true vector with 5 elevation bands (shallow water, lowland, hill, mountain,
high mountain) but its viewBox covers only lon -30..+330 (seam at 30W) and lat +80..-60
(Antarctica missing, north pole shaved).

We need lon -180..+180 and lat -90..+90 to match the rest of the app's overlays. Strategy:

  1.  Bake the source layer1 translate into a single affine transform that maps raw path coords
      directly to our target viewBox (0 0 360 180), where x = lon+180 and y = 90-lat.
  2.  Reference the source content twice with two horizontal offsets (-360 and 0 in target-X).
      The viewBox + overflow=hidden clip gives us a wrap-around that exactly fills lon -180..+180
      with no seam gap.
  3.  Pad the missing polar bands with the source's own shallow-water cyan (#aaeeff). This is
      consistent with the source's "bedrock dataset" convention - the Arctic IS open ocean and
      Antarctica's bedrock is largely below sea level once the ice sheet is removed.
  4.  Trim numeric precision and strip Inkscape namespaces.

Three layers (Alt / Biome / Slope) are emitted from the SAME source geometry, with different
per-band palettes and ocean-background tones. This keeps the file structure and projection math
identical across layers (one source of geographic truth) while giving each toggle its own visual
identity. They are *derived* from elevation, not separate Earth datasets - the chartBlurb in
basemap.json calls this out so users aren't misled.

Outputs (all with viewBox `0 0 360 180`, preserveAspectRatio="none"):
  - earth-topo5-equirect.svg            (alt   - hypsometric tints)
  - earth-topo5-biome-equirect.svg      (biome - vegetation tints)
  - earth-topo5-slope-equirect.svg      (slope - intensity tints)
"""
import os, re

ROOT = r'c:\Program Files (x86)\Steam\steamapps\common\Kerbal Space Program\KSCTowerNetwork-dev\web\public\maps'
SRC  = os.path.join(ROOT, '_earth_src', 'world_topo_5layers.svg')

# Source layer1 transform; each path's raw coords are pre-translate.
LAYER_TX = (-66.653633, -122.45008)

# Source viewBox covers lon range 360 deg over 60.965907 units, lat range 140 deg over 23.1156.
# Slight inequality (5.905 vs 6.056 deg/unit) is from a small printed margin and is below the
# graticule's resolution, so we treat it as equirectangular and absorb it into the matrix.
LON_PER_U = 360.0 / 60.965907   # ~5.9047
LAT_PER_U = 140.0 / 23.1156     # ~6.0561

# Composite affine for path coords (px, py) -> target (X, Y):
#   vbX, vbY = px + LAYER_TX[0], py + LAYER_TX[1]
#   lon      = -30 + vbX * LON_PER_U
#   lat      =  80 - vbY * LAT_PER_U
#   X        = lon + 180 + lon_offset
#   Y        =  90 - lat
# Substitute and collect:
#   X = px*LON_PER_U + (LAYER_TX[0]*LON_PER_U + 150 + lon_offset)
#   Y = py*LAT_PER_U + (LAYER_TX[1]*LAT_PER_U + 10)
def matrix_for(lon_offset: float) -> str:
    a = LON_PER_U
    d = LAT_PER_U
    e = LAYER_TX[0] * LON_PER_U + 150 + lon_offset
    f = LAYER_TX[1] * LAT_PER_U + 10
    return f'matrix({a:.6f} 0 0 {d:.6f} {e:.6f} {f:.6f})'


# Source path fills, in band-elevation order (shallow water -> high mountain).
SRC_BANDS = ['#aaeeff', '#5fd38d', '#aad400', '#d4aa00', '#aa4400']


# --- Per-layer palette / metadata -----------------------------------------------------------
# Each entry: (filename, ocean_bg, polar_pad, [recolor in band order], title, desc).
# `ocean_bg`  fills the deep ocean (source paths leave that transparent).
# `polar_pad` fills lat +80..+90 and lat -60..-90 (north & south of source coverage).
# `recolor`   maps the 5 source band colors to layer-specific colors; `None` keeps source.
LAYERS = [
    {
        'name'      : 'alt',
        'filename'  : 'earth-topo5-equirect.svg',
        'ocean_bg'  : '#cbe9f1',
        'polar_pad' : '#aaeeff',
        'recolor'   : [None, None, None, None, None],
        'title'     : 'Earth equirectangular topographic plate (5 elevation bands)',
        'desc'      : ('Adapted from Wikimedia Commons File:World_topo_5layers.svg by '
                       'Dbachmann (CC BY-SA 4.0 / GFDL). Elevation bands: shallow water '
                       '-130..0 m, lowlands 0..250 m, hills 250..1000 m, mountains 1000..2500 m, '
                       'high mountains 2500 m+. ETOPO1-derived bedrock dataset (Antarctica & '
                       'Greenland shown ice-free). Remapped to lon -180..+180 / lat -90..+90 by '
                       'KSCTowerNetwork build_earth_svg.py.'),
    },
    {
        'name'      : 'biome',
        'filename'  : 'earth-topo5-biome-equirect.svg',
        # Slightly deeper ocean blue so the layer reads as "marine biome".
        'ocean_bg'  : '#7fa9c4',
        # Polar pad in pale cyan suggests pack ice / polar sea.
        'polar_pad' : '#dde7ec',
        # Vegetation-suggestive remap (NOT real Köppen / WWF biome data - a visual coding of
        # elevation as a biome proxy: lowlands -> forest, hills -> grass, mid -> arid,
        # high mountain -> tundra/alpine).
        'recolor'   : ['#9bc4d9',  # shallow shelves -> coastal water
                       '#3f7a3e',  # lowlands        -> temperate forest
                       '#bca35e',  # hills           -> grassland / steppe
                       '#b07a3a',  # mountains       -> arid / desert
                       '#9aa098'], # high mountains  -> tundra / alpine bare
        'title'     : 'Earth equirectangular biome proxy plate (elevation-derived)',
        'desc'      : ('Visual biome coding derived from the same World_topo_5layers.svg source '
                       'as the alt layer (Dbachmann, CC BY-SA 4.0 / GFDL). NOT a published Koppen '
                       'or WWF biome dataset - the 5 elevation bands are simply re-coloured as '
                       'forest/grassland/arid/alpine, which is correlated with but not the same '
                       'as real-world biome distribution. Use for at-a-glance vegetation context; '
                       'rely on the in-game PQS biome bake from the KSP plugin for accurate live '
                       'data when available.'),
    },
    {
        'name'      : 'slope',
        'filename'  : 'earth-topo5-slope-equirect.svg',
        # Dark blue-grey background reads as "low relief reference".
        'ocean_bg'  : '#2f4858',
        'polar_pad' : '#3a4f5e',
        # Slope intensity proxy: tighter elevation bands -> steeper terrain. Cool colors for
        # flat regions, hot colors for the band that contains most mountainous terrain.
        'recolor'   : ['#3e6a82',  # shallow shelves -> nearly flat
                       '#3d8f7a',  # lowlands        -> mostly flat
                       '#d6c042',  # hills           -> moderate slope
                       '#e07b2a',  # mountains       -> steep
                       '#c12d1d'], # high mountains  -> very steep
        'title'     : 'Earth equirectangular slope proxy plate (elevation-derived)',
        'desc'      : ('Visual slope coding derived from the same World_topo_5layers.svg source '
                       'as the alt layer (Dbachmann, CC BY-SA 4.0 / GFDL). NOT a true slope or '
                       'ruggedness dataset - the 5 elevation bands are re-coloured by intensity '
                       'so the highest bands read as steep (red/orange) and the lowest bands as '
                       'flat (blue/green). This matches the visual intuition that high mountains '
                       'tend to be steep but should not be used for quantitative grade analysis. '
                       'Rely on the in-game PQS slope bake from the KSP plugin for accurate live '
                       'data when available.'),
    },
]


def _trim_path(p: str) -> str:
    """Strip Inkscape attrs, trim numeric precision in 'd' attrs."""
    def trim_num(m):
        v = float(m.group(0))
        out = f'{v:.3f}'.rstrip('0').rstrip('.')
        return out if out else '0'
    p = re.sub(r'-?\d+\.\d{3,}', trim_num, p)
    p = re.sub(r'\s+(?:inkscape|sodipodi):[a-zA-Z_-]+="[^"]*"', '', p)
    return p


def _fill_of(p: str) -> str:
    m = re.search(r'fill="(#[0-9a-fA-F]+)"', p)
    if m: return m.group(1).lower()
    m = re.search(r'fill\s*:\s*(#[0-9a-fA-F]+)', p)
    return m.group(1).lower() if m else ''


def build_layer(spec: dict, raw_paths: list[str]) -> str:
    """Compose the SVG text for one layer."""
    paths_sorted = sorted(
        raw_paths,
        key=lambda p: SRC_BANDS.index(_fill_of(p)) if _fill_of(p) in SRC_BANDS else 99,
    )

    cleaned = []
    for p in paths_sorted:
        p = _trim_path(p)
        src_fill = _fill_of(p)
        if src_fill in SRC_BANDS:
            band_idx = SRC_BANDS.index(src_fill)
            new_fill = spec['recolor'][band_idx]
            if new_fill is not None:
                # Replace the path's fill="..." or style="fill:...".
                if re.search(r'\bfill="#[0-9a-fA-F]+"', p):
                    p = re.sub(r'\bfill="#[0-9a-fA-F]+"', f'fill="{new_fill}"', p, count=1)
                else:
                    p = re.sub(r'(fill\s*:\s*)#[0-9a-fA-F]+', rf'\1{new_fill}', p, count=1)
        cleaned.append(p)

    parts = []
    parts.append('<?xml version="1.0" encoding="UTF-8"?>')
    parts.append('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
                 'viewBox="0 0 360 180" preserveAspectRatio="none" overflow="hidden" '
                 'shape-rendering="geometricPrecision">')
    parts.append(f'<title>{spec["title"]}</title>')
    parts.append(f'<desc>{spec["desc"]}</desc>')

    parts.append(f'<rect x="0" y="0" width="360" height="180" fill="{spec["ocean_bg"]}"/>')
    parts.append(f'<rect x="0" y="0" width="360" height="10" fill="{spec["polar_pad"]}"/>')   # +80..+90
    parts.append(f'<rect x="0" y="150" width="360" height="30" fill="{spec["polar_pad"]}"/>') # -60..-90

    parts.append('<defs><g id="earth-content">')
    parts.extend(cleaned)
    parts.append('</g></defs>')

    parts.append(f'<use href="#earth-content" transform="{matrix_for(0)}"/>')
    parts.append(f'<use href="#earth-content" transform="{matrix_for(-360)}"/>')

    # Cosmetic 30 degree graticule baseline (the app draws its own labelled graticule on top).
    parts.append('<g fill="none" stroke="#1a4a6a" stroke-opacity="0.18" stroke-width="0.25">')
    for lon in range(0, 361, 30):
        parts.append(f'<line x1="{lon}" y1="0" x2="{lon}" y2="180"/>')
    for lat in range(0, 181, 30):
        parts.append(f'<line x1="0" y1="{lat}" x2="360" y2="{lat}"/>')
    parts.append('</g>')

    parts.append('</svg>')
    return '\n'.join(parts)


def main() -> None:
    raw = open(SRC, 'r', encoding='utf-8').read()
    raw_paths = re.findall(r'<path\b[^/]*?/>', raw, flags=re.DOTALL)
    if len(raw_paths) < 5:
        raw_paths = re.findall(r'<path\b[^>]*?(?:/>|>\s*</path>)', raw, flags=re.DOTALL)
    print('source paths:', len(raw_paths))

    for spec in LAYERS:
        out_path = os.path.join(ROOT, spec['filename'])
        text = build_layer(spec, raw_paths)
        open(out_path, 'w', encoding='utf-8').write(text)
        print(' wrote', spec['name'], '->', out_path, '(', os.path.getsize(out_path), 'bytes )')


if __name__ == '__main__':
    main()
