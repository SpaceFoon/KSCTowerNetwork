"""Import real spherical maps without changing the KSP installation.

Requires Pillow; stock extraction also requires UnityPy 1.25.4.
Run with --ksp <install>, --avp <AVP directory>, and/or --download-opm.
No installation paths are persisted in the generated provenance files.
"""

import argparse
import io
import json
from pathlib import Path
from urllib.request import urlopen

from PIL import Image

DEV = Path(__file__).resolve().parents[1]
OUTPUT = DEV / "web/public/globes"
OPM_REVISION = "ffedf02e23d2d620e1018d1467f5e485f7950fa0"
STOCK_COLORS = {
    "moho": "moho01", "eve": "Eve2_00", "gilly": "evemoon100",
    "minmus": "NewMunSurfaceMap00", "duna": "Duna [Albedo]",
    "ike": "desertplanetmoon00", "dres": "dwarfplanet100",
    "jool": "CloudPattern_low", "laythe": "newoceanmoon00",
    "vall": "gp1icemoon00", "tylo": "rockyMoon00",
    "bop": "gp1minormoon100", "pol": "gp1minormoon200",
    "eeloo": "snowydwarfplanet00", "mun": "NewMunSurfaceMapDiffuse",
}
OPM_BODIES = "Sarnus Hale Ovok Eeloo Slate Tekto Urlum Polta Priax Wal Tal Neidon Thatmo Nissee Plock Karen".split()
CLOUD_FILES = {"kerbin": "kerbin1", "laythe": "laythe1", "eve": "eve1", "duna": "duna1", "jool": "joolLayers1", "cirrus": "cirrus"}


def write_json(name, data):
    (OUTPUT / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def import_stock(install):
    import UnityPy

    sources = {}
    for asset in ("sharedassets9.assets", "sharedassets2.assets"):
        path = install / "KSP_x64_Data" / asset
        if not path.exists():
            continue
        env = UnityPy.load(str(path))
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            name = obj.peek_name()
            body = next((key for key, value in STOCK_COLORS.items() if value == name), None)
            if body is None:
                continue
            image = obj.parse_as_object().image.convert("RGB")
            filename = f"{body}-stock.webp"
            image.save(OUTPUT / filename, quality=94, method=6)
            sources[body] = {"url": f"/globes/{filename}", "source": "KSP stock scaled-space",
                             "texture": name, "asset": asset, "width": image.width, "height": image.height}
            print(body, image.size, flush=True)
    missing = set(STOCK_COLORS) - sources.keys()
    if missing:
        raise RuntimeError(f"Missing stock textures: {sorted(missing)}. This importer targets KSP 1.12 assets.")
    sources["kerbin"] = {"url": "/globes/kerbin-stock.png", "source": "KSP terrain",
                         "width": 8192, "height": 4096, "texture": "Kerbin_600000_v4__alt.png",
                         "asset": "KSCTowerNetwork plugin map cache"}
    write_json("stock-sources.json", sources)


def import_clouds(avp):
    sources = {}
    for body, name in CLOUD_FILES.items():
        path = avp / "AVP_Configs/Textures" / f"{name}.dds"
        image = Image.open(path).convert("RGBA").transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        alpha = image.getchannel("A")
        alpha.thumbnail((4096, 2048), Image.Resampling.LANCZOS)
        # The shader uses EVE's coverage channel and configured body tint, not RGB.
        mask = Image.new("RGBA", alpha.size, "white")
        mask.putalpha(alpha)
        filename = f"{body}-avp-clouds.webp"
        mask.save(OUTPUT / filename, lossless=True, method=6)
        sources[body] = {"url": f"/globes/{filename}", "source": "Astronomer's Visual Pack",
                         "texture": f"AVP_Configs/Textures/{name}.dds",
                         "originalWidth": image.width, "originalHeight": image.height,
                         "width": mask.width, "height": mask.height,
                         "transformation": "Vertical flip; alpha coverage; maximum 4096 x 2048; lossless WebP"}
    write_json("cloud-sources.json", sources)


def import_opm(revision):
    sources = {}
    base = f"https://raw.githubusercontent.com/Poodmund/Outer-Planets-Mod/{revision}/"
    for body in OPM_BODIES:
        texture = f"{body}_color.dds"
        with urlopen(base + "GameData/OPM/OPM_Textures/PluginData/" + texture, timeout=60) as response:
            image = Image.open(io.BytesIO(response.read())).transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert("RGB")
        filename = f"{body.lower()}-opm.webp"
        image.save(OUTPUT / filename, quality=94, method=6)
        sources[body.lower()] = {"url": f"/globes/{filename}", "source": "Outer Planets Mod",
                                 "texture": texture, "repository": "https://github.com/Poodmund/Outer-Planets-Mod",
                                 "revision": revision, "width": image.width, "height": image.height}
        if body in ("Sarnus", "Urlum"):
            with urlopen(base + f"GameData/OPM/OPM_Textures/PluginData/{body}_ring.dds", timeout=60) as response:
                ring = Image.open(io.BytesIO(response.read())).convert("RGBA")
            ring.save(OUTPUT / f"{body.lower()}-opm-ring.webp", lossless=True)
        print(body, image.size, flush=True)
    write_json("opm-sources.json", sources)


def generate_registry():
    output = "// Generated by scripts/import-globe-textures.py. Asset provenance is in public/globes/*-sources.json.\n"
    for kind in ("stock", "opm"):
        sources = json.loads((OUTPUT / f"{kind}-sources.json").read_text(encoding="utf-8"))
        output += f"export const {kind}Surfaces = " + json.dumps(sources, indent=2) + ";\n"
        for source in sources.values():
            path = OUTPUT / source["url"].split("/")[-1]
            marker = Image.open(path).convert("RGB")
            marker.thumbnail((512, 256), Image.Resampling.LANCZOS)
            marker.save(path.with_name(path.stem + "-marker.webp"), quality=85, method=6)
    (DEV / "web/src/data/globeAssetSources.ts").write_text(output, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ksp", type=Path)
    parser.add_argument("--avp", type=Path)
    parser.add_argument("--download-opm", action="store_true", help="Explicitly fetch the official OPM textures")
    parser.add_argument("--opm-revision", default=OPM_REVISION)
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.ksp:
        import_stock(args.ksp)
    if args.avp:
        import_clouds(args.avp)
    if args.download_opm:
        import_opm(args.opm_revision)
    generate_registry()
