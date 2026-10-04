# `kerbin-stock` body basemaps

Equirectangular vector basemaps for stock-Kerbol bodies. Loaded by `BodyMap.tsx`
via the URL pattern `/maps/kerbin-stock/{bodyName}.svg`.

## Why placeholders are committed

The "real" surface plates are produced by `TowerBasemapBaker.cs` running
in-game against a clean stock KSP install. That bake samples `PQS.GetSurfaceHeight`
on a 720x360 grid and emits a hypsometric-band SVG that matches the tower map
viewBox (596×298).

Until those bakes exist, this directory ships **simple flat-color placeholders**
(one solid rect per body, in roughly the body's in-game appearance) so the
TowerDesk map renders something recognizable when a controller focuses Mun /
Minmus / Duna / etc. The placeholder viewBox matches the real bake (596x298) so
the navaid and graticule overlays line up either way.

## How to replace a placeholder with a real bake

1. Start KSP with **only stock parts + the KSCTowerNetwork plugin** (no planet
   packs).
2. Enter the Space Center and let `TowerBasemapBaker` run for the home body
   (Kerbin) - it auto-publishes via the existing flow.
3. For non-home bodies, invoke the dev-only bulk bake (see
   `BakeAllBodies` static helper, gated behind an admin button in the plugin UI):
   it iterates `FlightGlobals.Bodies`, runs `BakeBody(body)` for each, and POSTs
   to `/v1/world-maps/{sessionId}/{bodyName}` (multi-body route added by the
   real-tower roadmap).
4. Intercept the POSTs locally and save each `svgBase64` decoded into this
   directory as `{bodyName}.svg`.
5. Commit. Drop the placeholder.

The home body (Kerbin) default basemap is controlled by `web/public/maps/basemap.json`
(`kerbin-base-schematic.svg` plus live bake when connected). This directory is for
**other** bodies when the operator focuses them in the tower UI.
