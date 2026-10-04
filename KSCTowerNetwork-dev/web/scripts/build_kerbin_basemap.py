"""Bake a custom Kerbin basemap and update `public/maps/basemap.json`.

- **Raster** (PNG/WebP/JPEG, …): resize to 596×298, write WebP, set manifest `kind: raster`.
- **SVG**: copy into `public/maps/` and set manifest `kind: svg`.

ViewBox size must match `KERBIN_MAP_VB_W` / `KERBIN_MAP_VB_H` in `src/pages/TowerDesk.tsx`.

Usage:
  pip install -r scripts/requirements-basemap.txt   # raster only
  python scripts/build_kerbin_basemap.py --input ./my-kerbin.png
  python scripts/build_kerbin_basemap.py --input ./my-kerbin.svg --output-name kerbin-custom.svg
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
MAPS = WEB / "public" / "maps"
MANIFEST = MAPS / "basemap.json"

# Must match TowerDesk.tsx
VB_W = 596
VB_H = 298


def _load_manifest() -> dict:
    if MANIFEST.is_file():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"assetVersion": 0}


def _write_manifest(
    *,
    kind: str,
    uri: str,
    attribution: str,
    chart_blurb: str | None,
    hypsometry_key: str,
) -> None:
    prev = _load_manifest()
    ver = int(prev.get("assetVersion", 0)) + 1
    data: dict = {
        "projection": "equirectangular",
        "viewBoxWidth": VB_W,
        "viewBoxHeight": VB_H,
        "kind": kind,
        "uri": uri,
        "assetVersion": ver,
        "attribution": attribution,
        "hypsometryKey": hypsometry_key,
    }
    if chart_blurb:
        data["chartBlurb"] = chart_blurb
    elif prev.get("chartBlurb"):
        data["chartBlurb"] = prev["chartBlurb"]
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST} (assetVersion={ver})")


def _bake_raster(src: Path, out_webp: Path, quality: int) -> None:
    from PIL import Image, ImageOps

    im = Image.open(src).convert("RGBA")
    im = ImageOps.fit(im, (VB_W, VB_H), method=Image.Resampling.LANCZOS)
    out_webp.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_webp, format="WEBP", quality=quality, method=6)
    print(f"wrote {out_webp} ({out_webp.stat().st_size} bytes)")


def main() -> None:
    p = argparse.ArgumentParser(description="Bake Kerbin basemap into public/maps/")
    p.add_argument("--input", required=True, type=Path, help="Source image (raster) or SVG")
    p.add_argument(
        "--out-dir",
        type=Path,
        default=MAPS,
        help=f"Output directory (default: {MAPS})",
    )
    p.add_argument("--webp-quality", type=int, default=85, help="WebP quality 1–100 (raster only)")
    p.add_argument(
        "--output-name",
        default="kerbin-basemap.webp",
        help="Raster output filename under out-dir (default: kerbin-basemap.webp)",
    )
    p.add_argument(
        "--svg-name",
        default="kerbin-basemap.svg",
        help="SVG output filename under out-dir (default: kerbin-basemap.svg)",
    )
    p.add_argument(
        "--attribution",
        default="Custom basemap (see public/maps/README.md). Replace this string with your license/credits.",
        help="Short attribution stored in basemap.json",
    )
    p.add_argument(
        "--chart-blurb",
        default=None,
        help="Optional chart key intro; omit to leave previous basemap.json value or default in UI",
    )
    p.add_argument(
        "--hypsometry-key",
        choices=("jebbesen", "generic"),
        default="generic",
        help="Chart key hypsometry section: jebbesen (full) or generic (short)",
    )
    args = p.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"Missing input file: {args.input}")

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    suf = args.input.suffix.lower()

    if suf == ".svg":
        dest = out_dir / args.svg_name
        shutil.copy2(args.input, dest)
        uri = f"maps/{dest.name}"
        _write_manifest(
            kind="svg",
            uri=uri,
            attribution=args.attribution,
            chart_blurb=args.chart_blurb,
            hypsometry_key=args.hypsometry_key,
        )
        print(f"copied SVG to {dest}")
        return

    if suf in (".png", ".webp", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"):
        dest = out_dir / args.output_name
        if dest.suffix.lower() != ".webp":
            dest = dest.with_suffix(".webp")
        _bake_raster(args.input, dest, min(100, max(1, args.webp_quality)))
        uri = f"maps/{dest.name}"
        _write_manifest(
            kind="raster",
            uri=uri,
            attribution=args.attribution,
            chart_blurb=args.chart_blurb,
            hypsometry_key=args.hypsometry_key,
        )
        return

    raise SystemExit(f"Unsupported input type: {suf} (use .svg or a raster image)")


if __name__ == "__main__":
    main()
