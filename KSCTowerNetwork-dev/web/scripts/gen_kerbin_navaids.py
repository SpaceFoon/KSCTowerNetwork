"""Emit src/data/kerbinNavaids.ts from MOARdV MAS_NavAid.cfg (run from repo machine with KSP + MOARdV)."""
from __future__ import annotations

import re
import pathlib

CFG = pathlib.Path(
    r"c:\Program Files (x86)\Steam\steamapps\common\Kerbal Space Program\GameData\MOARdV\AvionicsSystems\MAS_NavAid.cfg"
)
OUT = pathlib.Path(__file__).resolve().parents[1] / "src" / "data" / "kerbinNavaids.ts"


def main() -> None:
    text = CFG.read_text(encoding="utf-8")
    parts = re.split(r"\tNAVAID\s*\n\t\{", text)
    entries: list[dict] = []
    for blk in parts[1:]:

        def grab(key: str) -> str | None:
            m = re.search(r"^[\t ]*" + re.escape(key) + r"\s*=\s*([^\n]+)", blk, re.M)
            return m.group(1).strip() if m else None

        name = grab("name")
        id_ = grab("id")
        typ = grab("type")
        freq = grab("frequency")
        lat = grab("latitude")
        lon = grab("longitude")
        if not all([name, id_, typ, freq, lat, lon]):
            continue
        try:
            latf = float(lat)
            lonf = float(lon)
            freqf = float(freq)
        except ValueError:
            continue
        tupper = typ.upper()
        kind = "VOR" if "VOR" in tupper else ("ILS" if "ILS" in tupper else "NDB")
        entries.append(
            {"id": id_, "name": name, "kind": kind, "type": typ, "freqMHz": freqf, "lat": latf, "lon": lonf}
        )

    seen: set[tuple] = set()
    out: list[dict] = []
    for e in entries:
        key = (e["id"], e["kind"], round(e["lat"], 8), round(e["lon"], 8))
        if key in seen:
            continue
        seen.add(key)
        out.append(e)

    # MAS lists KKSC locator NDBs and ILS at same ids; keep ILS only for tower map markers.
    out = [e for e in out if not (e["kind"] == "NDB" and e["id"] in ("IKW", "IWE"))]

    lines = [
        f"  {{ id: {e['id']!r}, name: {e['name']!r}, kind: {e['kind']!r}, frequency: {e['freqMHz']!r}, lat: {e['lat']!r}, lon: {e['lon']!r} }},"
        for e in out
    ]
    header = """/** Kerbin radio navaids from MOARdV AvionicsSystems `MAS_NavAid.cfg` (MAS in-game network). */
export type KerbinNavAidKind = "VOR" | "ILS" | "NDB";

export type KerbinNavAid = {
  id: string;
  name: string;
  kind: KerbinNavAidKind;
  /** Value from cfg `frequency` (MHz for VOR/ILS; NDB uses cfg kHz-style values as in MAS). */
  frequency: number;
  lat: number;
  lon: number;
};

export const KERBIN_NAVAIDS: KerbinNavAid[] = [
"""
    footer = "];\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(header + "\n".join(lines) + "\n" + footer, encoding="utf-8")
    print(f"wrote {OUT} ({len(out)} aids)")


if __name__ == "__main__":
    main()
