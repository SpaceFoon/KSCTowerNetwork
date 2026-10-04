# `earth-rss` body basemaps

Equirectangular vector basemaps for Real Solar System bodies. Loaded by `BodyMap.tsx` via the
URL pattern `/maps/earth-rss/{bodyName}.svg`.

## What's here

29 placeholder SVGs covering the major RSS-stock bodies (Mercury, Venus, Moon, Mars, Phobos,
Deimos, Jovian/Cronian/Uranian/Neptunian moons, Pluto, Charon). Earth itself is NOT here — it
ships from the existing `web/public/maps/earth-topo5-equirect.svg` via `basemap.json`, which
the legacy TowerDesk render uses when an RSS player focuses their home (Earth).

If a controller forces focus to Earth on a non-Earth-home install (very rare combo), `BodyMap`
will request `/maps/earth-rss/Earth.svg` and fall through to the in-component stub disc. To
provide a real plate for that path, copy/symlink the existing topo SVG here.

## How to replace placeholders with real bakes

Run `TowerBasemapBaker` against a clean RSS install (RealSolarSystem + Kopernicus mods only),
loop over `FlightGlobals.Bodies` from a dev-only admin button, intercept the POSTs locally,
and save each `svgBase64` decoded into this directory as `{bodyName}.svg`. Drop the placeholder.
