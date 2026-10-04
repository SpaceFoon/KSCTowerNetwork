# `kerbin-opm` body basemaps

Equirectangular vector basemaps for stock Kerbol + Outer Planets Mod (Sarnus, Urlum, Neidon,
Plock subsystems plus relocated Eeloo). Loaded by `BodyMap.tsx` via the URL pattern
`/maps/kerbin-opm/{bodyName}.svg`.

OPM keeps the stock home body (Kerbin) and stock inner-system geometry, then adds outer
gas/ice giants and their moon systems. The catalog in
`web/public/system-catalogs/kerbin-opm.json` mirrors that: stock entries match `kerbin-stock`
exactly, and the OPM additions use values from the OPM Kopernicus configs (radii, atmospheres,
semi-major axes). One notable OPM divergence from stock: **Eeloo** is a moon of Sarnus here,
not a Kerbol-orbiting dwarf planet.

## How to replace placeholders with real bakes

Run `TowerBasemapBaker` against a clean install with Kopernicus + OuterPlanetsMod (no other
planet packs). Loop over `FlightGlobals.Bodies` from the dev-only admin button, intercept the
POSTs locally, decode each `svgBase64`, and save into this directory as `{bodyName}.svg`.
Drop the placeholder.

Kerbin itself is the home body in OPM and uses the existing main map asset, so no `Kerbin.svg`
is shipped here.
