# Kerbin wall-map code review — 2026-10-19

## Scope

Reviewed the wall-map sizing implementation in `web/src/components/KerbinTowerMap.tsx` and
`web/src/maps/kerbinTerrainSvgPatch.ts`, plus the map loader, wall-slot CSS, SVG input handling,
pointer coordinate conversion, `TowerWall.tsx`, `BodyMap.tsx`, and `docs/WEB_SPA.md`.

## Findings

### [P2] Wall fill can update a descendant SVG instead of the outer map SVG

**Status:** Resolved. The helper now scopes the aspect and legacy viewBox updates to the outer `<svg>`.

**Location:** `web/src/maps/kerbinTerrainSvgPatch.ts:50`

The helper searched the entire SVG string for `preserveAspectRatio` and replaced the first match. If
the outer `<svg>` had no such attribute but a nested `<svg>` did, the replacement changed the nested
element and left the outer map at SVG's default `xMidYMid meet`. In wall mode, the separate overlay
root uses `preserveAspectRatio="none"`, so a non-2:1 slot could letterbox the terrain while
stretching its grid and markers across the slot. Those layers could visibly drift apart.

The checked-in default Kerbin basemap has the attribute on its root, so that asset was unaffected.
The backend schema also accepts SVG map layers, making the nested-SVG case a valid supported input
shape.

**Suggested fix:** inspect and patch the outer `<svg>` opening tag only; insert the attribute there
if it is absent. Add a regression case with a root that omits the attribute and a descendant SVG
that has one, and assert that wall mode sets the root to `none` while preserving the descendant
value.

### [P2] Off-home body maps bypass wall-fill sizing

**Status:** Resolved. Wall slots now enable fill sizing on `BodyMap` and its basemap image.

**Location:** `TowerWall.tsx:2618`

`BodyMapSlot` rendered `KerbinTowerMap` with `wallSlot` only while the vessel was on its home body.
For a vessel on another body, it switched to `BodyMap`, whose SVG kept `xMidYMid meet` and whose
CSS set `height: auto`; the nested basemap `<image>` also kept `xMidYMid meet`. The off-home map
therefore stayed at its normal 2:1 sizing inside the wall cell instead of filling a tall or
otherwise non-2:1 slot. The documented wall-map behavior in `docs/WEB_SPA.md:302-305` says wall-slot
maps stretch terrain and overlays to fill the available width and height. The off-home map path did
not follow that sizing behavior.

**Suggested fix:** give the off-home `BodyMap` a wall-fill mode that sizes the SVG to the slot and
applies `preserveAspectRatio="none"` consistently to both the root SVG and its basemap image. If
off-home maps are intentionally excluded, narrow the wall-map documentation to say so.

## Review notes

- The current default Kerbin map and ordinary desk-map path retain their intended aspect behavior.
- Helper tests exercise the override when the root already has a `preserveAspectRatio` attribute,
  but do not cover a nested attribute or a root with no such attribute.
- Kerbin raster basemaps still use CSS `object-fit: fill`; its new aspect setting affects the vector terrain path.
- Zoom anchoring and map picking use the overlay SVG's screen transform, so their coordinate
  conversion follows the stretched viewport.
- Both current wall-map call sites pass `wallSlot` as a fixed prop; no active prop-toggle refetch issue was found.
- This review was static. No tests or browser rendering checks were run.

## Pre-release disposition

**Both P2 findings are resolved in source and documented.** The TypeScript typecheck passed with
`npm.cmd run typecheck`. The test suite and browser/runtime validation were not run, so visual
release behavior remains unverified.
