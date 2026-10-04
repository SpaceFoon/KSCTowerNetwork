# `kerbin-jnsq` body basemaps

Equirectangular vector basemaps for JNSQ (Jool's New System Quest). Loaded by `BodyMap.tsx`
via the URL pattern `/maps/kerbin-jnsq/{bodyName}.svg`.

JNSQ is a stock-rebalance pack: home body is still named `Kerbin` but at 2.7x stock radius and
roughly 10x the inter-body distances, plus extra moons and a Lindor sub-system. The catalog
constants in `web/public/system-catalogs/kerbin-jnsq.json` are approximate (drawn from the JNSQ
config files); a controller installing JNSQ on top of an exact patch may see slight scale drift
and should re-bake.

## How to replace placeholders with real bakes

Run `TowerBasemapBaker` against a clean JNSQ install (Kopernicus + JNSQ + dependencies only),
loop over `FlightGlobals.Bodies` from a dev-only admin button, intercept the POSTs locally,
and save each `svgBase64` decoded into this directory as `{bodyName}.svg`. Drop the placeholder.
