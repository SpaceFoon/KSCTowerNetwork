"""Generate an optional web chart installation from an owner-supplied PDF."""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

import pymupdf as fitz
import index_aerocharts as index


def install(pdf: Path, output: Path) -> None:
    pdf = pdf.resolve(strict=True)
    output = output.resolve()
    with fitz.open(pdf) as document:
        if len(document) != len(index.PAGE_INFO):
            raise ValueError("Use the complete 22-page November 25, 2017 Kerbin Aeronautical Charts PDF")
        if output.exists():
            if not output.is_dir():
                raise ValueError("Output must be a directory")
            names = {item.name for item in output.iterdir()}
            if names - {"manifest.json", "README.md"}:
                raise ValueError("Output contains files; generate into a new folder")
            existing = output / "manifest.json"
            if existing.exists() and json.loads(existing.read_text(encoding="utf-8")).get("pages"):
                raise ValueError("A chart bundle is already installed; generate into a new folder")
        output.parent.mkdir(parents=True, exist_ok=True)
        # Prepare all assets before replacing the empty manifest, which enables the viewer.
        with tempfile.TemporaryDirectory(prefix="chart-install-", dir=output.parent) as staging:
            charts = Path(staging)
            target_pdf = charts / "Kerbin_AEROCHARTS-25-nov-2017.pdf"
            shutil.copyfile(pdf, target_pdf)
            pages = []
            for number, page in enumerate(document, 1):
                image = f"page_{number:02}.png"
                thumb = f"page_{number:02}_thumb.png"
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                pixmap.save(str(charts / image))
                page.get_pixmap(matrix=fitz.Matrix(0.25, 0.25), alpha=False).save(str(charts / thumb))
                title, tag, category = index.PAGE_INFO[number - 1]
                pages.append({"page": number, "file": "/charts/" + image, "thumb": "/charts/" + thumb,
                              "widthPx": pixmap.width, "heightPx": pixmap.height, "title": title,
                              "blurb": "", "chartTag": tag, "category": category})
            manifest = {"pageCount": len(pages), "renderZoom": 2, "pages": pages}
            (charts / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            index.CHARTS, index.PDF = charts, target_pdf
            index.main()
            (charts / "ATTRIBUTION.txt").write_text(
                "Kerbin Aeronautical Charts, 25 November 2017\n"
                "Author: alexustas / ASET Aviation Agency\n"
                f"Source: {index.SOURCE_URL}\n"
                "License: CC BY-NC-SA 3.0 https://creativecommons.org/licenses/by-nc-sa/3.0/\n"
                "Adaptations: rendered pages, thumbnails, and extracted text/navigation data.\n"
                "Retain attribution and license with redistributions. No endorsement is implied.\n", encoding="utf-8")
            output.mkdir(exist_ok=True)
            for item in charts.iterdir():
                if item.name != "manifest.json":
                    shutil.copyfile(item, output / item.name)
            shutil.copyfile(charts / "manifest.json", output / "manifest.json")
    print(f"Installed charts in {output}. Serve this folder at /charts/ and reload the Charts page.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="Local upstream PDF downloaded by the server owner")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "dist" / "charts",
                        help="Destination charts directory; default: web/dist/charts (install after building)")
    args = parser.parse_args()
    try:
        install(args.pdf, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Chart installation failed: {error}\n")
