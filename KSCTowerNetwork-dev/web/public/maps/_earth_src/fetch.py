"""Fetch the upstream Wikimedia source SVGs we use to derive Earth basemap layers.

Each entry pairs a Wikimedia file URL with the local filename we save it as. The actual
remap to our equirectangular plate is handled by the per-layer build_*_svg.py scripts.
Re-running this script is idempotent; it's safe to delete the local copies and re-fetch.
"""
import os, urllib.request

DEST_DIR = r'c:\Program Files (x86)\Steam\steamapps\common\Kerbal Space Program\KSCTowerNetwork-dev\web\public\maps\_earth_src'

SOURCES = [
    # 5-band hypsometric vector (alt). Lon -30..+330, lat +80..-60. Used by build_earth_svg.py.
    ('https://upload.wikimedia.org/wikipedia/commons/2/2e/World_topo_5layers.svg',
     'world_topo_5layers.svg'),
    # 14-class WWF biome vector via Wikimedia's Special:FilePath redirect (avoids guessing
    # the content-hash CDN path). Robinson projection so we don't use the polygons directly,
    # but we keep it for reference and to extract the canonical biome palette.
    ('https://commons.wikimedia.org/wiki/Special:FilePath/Biomes_of_the_world.svg',
     'biomes_of_the_world.svg'),
    # Koppen-Geiger climate vector (biome alt). Equirectangular but mostly an embedded raster
    # with vector country borders on top, so unusable as a true vector source. Kept for
    # reference only; build_earth_biome_svg.py derives biomes from latitude bands + the topo5
    # land mask instead.
    ('https://commons.wikimedia.org/wiki/Special:FilePath/World_K%C3%B6ppen_Classification_%28with_authors%29.svg',
     'world_koppen_classification.svg'),
]

os.makedirs(DEST_DIR, exist_ok=True)

for url, name in SOURCES:
    dest = os.path.join(DEST_DIR, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        print('skip', name, '(', os.path.getsize(dest), 'bytes already on disk)')
        continue
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'KSCTowerNetwork/0.1 (https://localhost; offline mod dev) Python-urllib'},
    )
    print('fetch', url)
    try:
        # Wikimedia's Special:FilePath returns 302 to the upload.wikimedia.org CDN; urllib's
        # default opener follows that automatically.
        with urllib.request.urlopen(req) as r:
            data = r.read()
    except Exception as exc:
        print('  ! failed:', exc)
        continue
    with open(dest, 'wb') as f:
        f.write(data)
    print('  ->', dest, len(data), 'bytes')
