"""Index every PDF page and its printed navaid rows without changing source values.

Requires pypdf. The full PDF and page images preserve information in diagrams
and custom fonts that text extraction cannot represent faithfully.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from pypdf import PdfReader

CHARTS = Path(__file__).resolve().parents[1] / "public" / "charts"
PDF = CHARTS / "Kerbin_AEROCHARTS-25-nov-2017.pdf"
SOURCE_URL = "https://github.com/StoneBlue/ASET-Consolidated-Avionics/blob/main/Docs%20%26%20Manuals/ASET%20Consolidated%20Avionics-%20Kerbin%20AEROCHARTS%20v17-11-25.pdf"
PAGE_INFO = [
    ("Cover", "0-1", "Introduction"),
    ("Terrain Map", "1-1", "Maps"),
    ("Navaids Overview", "2-1", "Maps"),
    ("Navaids — North-West", "2-2", "Maps"),
    ("Navaids — North-East", "2-3", "Maps"),
    ("Navaids — South-East", "2-4", "Maps"),
    ("Navaids — South-West", "2-5", "Maps"),
    ("KSC Sector Navaids", "2-6", "Maps"),
    ("Navaids — VOR DME", "2-7", "Navigation"),
    ("Navaids — NDB DME", "2-8", "Navigation"),
    ("ILS DME and Markers", "2-9", "Navigation"),
    ("KKSC Aerodrome Chart", "3-1", "Aerodromes"),
    ("KAFD Aerodrome Chart", "3-2", "Aerodromes"),
    ("KKSC ILS Overview", "4-1", "Approaches"),
    ("KKSC ILS DME RWY 09", "4-2", "Approaches"),
    ("KKSC ILS DME RWY 27", "4-3", "Approaches"),
    ("Intentionally Blank", None, "Introduction"),
    ("Aerochart Legend — Symbols", "A-1", "Reference"),
    ("Aerochart Legend — Procedures", "A-2", "Reference"),
    ("Definitions, Acronyms and Speed Conversion", "A-3", "Reference"),
    ("Normal Operating Checklists", "A-4", "Checklists"),
    ("Distance Rulers and Protractors", None, "Reference"),
]

DMS = r"\d+°\s*\d+[’']\s*\d+[”\"]\s*[NSEW]"
NAVAID_ROW = re.compile(
    rf"(?P<id>[A-Za-z][A-Za-z0-9]*)\s+(?P<frequency>\d{{2,3}}\.\d{{2}})\s+"
    rf"(?P<morse>[−∙·\s]*)\s*(?P<latitude>{DMS})\s*"
    rf"(?P<longitude>{DMS})\s*(?P<altitude>-?\d+(?:\.\d+)?)"
)


def decimal_degrees(value: str) -> float:
    degrees, minutes, seconds = map(int, re.findall(r"\d+", value))
    result = degrees + minutes / 60 + seconds / 3600
    return round(-result if value.rstrip()[-1] in "SW" else result, 9)


def main() -> None:
    manifest_path = CHARTS / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    reader = PdfReader(PDF)
    if len(reader.pages) != len(PAGE_INFO) or len(manifest["pages"]) != len(PAGE_INFO):
        raise ValueError("Expected all 22 PDF pages and matching rendered page assets")
    rows = []
    page_records = []
    for index, page in enumerate(reader.pages):
        number = index + 1
        title, tag, category = PAGE_INFO[index]
        spans = []

        def visit(text, cm, tm, font, size):
            if not text.strip():
                return
            # Retain both matrices: rotated checklist text needs the original
            # transforms; a flattened transcript loses its column association.
            spans.append({"text": text, "contentMatrix": list(cm), "textMatrix": list(tm), "fontSize": float(size)})

        text = page.extract_text(visitor_text=visit)
        record = manifest["pages"][index]
        if record["page"] != number:
            raise ValueError("Manifest pages must be ordered by physical PDF page")
        for asset in (record["file"], record["thumb"]):
            if not (CHARTS / Path(asset).name).is_file():
                raise FileNotFoundError(asset)
        record.update(title=title, chartTag=tag, category=category, text=text)
        page_records.append({"page": number, "chartTag": tag, "title": title, "text": text, "textSpans": spans,
                             "mediaBox": list(map(float, page.mediabox))})
        if number in (9, 10):
            for match in NAVAID_ROW.finditer(text):
                values = match.groupdict()
                rows.append({"sourcePage": number, "sourceChart": tag, "row": len(rows) + 1,
                             "id": values["id"], "frequencyPrinted": values["frequency"],
                             "morsePrinted": values["morse"].strip(),
                             "latitudePrinted": values["latitude"], "longitudePrinted": values["longitude"],
                             "latitudeDeg": decimal_degrees(values["latitude"]),
                             "longitudeDeg": decimal_degrees(values["longitude"]),
                             "altitudeM": float(values["altitude"]), "rawText": match.group(0)})
    digest = hashlib.sha256(PDF.read_bytes()).hexdigest()
    manifest.update(schemaVersion=2, source=PDF.name, sourceUrl=SOURCE_URL,
                    sourcePdf="/charts/" + PDF.name, sourceSha256=digest,
                    author="alexustas / ASET Aviation Agency",
                    license="CC BY-NC-SA 3.0", licenseUrl="https://creativecommons.org/licenses/by-nc-sa/3.0/",
                    publicationDate="2017-11-25", pageCount=len(reader.pages),
                    referenceData="/charts/reference-data.json")
    data = {"schemaVersion": 1, "sourcePdf": manifest["sourcePdf"], "sourceSha256": digest,
            "sourceUrl": SOURCE_URL, "author": manifest["author"], "license": manifest["license"],
            "licenseUrl": manifest["licenseUrl"], "pages": page_records, "printedNavaidRows": rows,
            "extractionNote": "Source transcription, not a corrected navigation database. Duplicate/placeholder rows and conflicting printed identifiers are preserved. PDF and chart images are authoritative for diagrams, layout, and custom-font symbols."}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (CHARTS / "reference-data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Indexed {len(reader.pages)} pages, {len(rows)} printed navaid rows; PDF SHA256 {digest}")


if __name__ == "__main__":
    main()
