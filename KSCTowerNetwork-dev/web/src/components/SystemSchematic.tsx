import { JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  basemapUrlFor,
  type SystemCatalog,
  type SystemCatalogBody
} from "../data/systemCatalog";

/**
 * Concentric solar-system schematic. The star sits at the center; planets are placed on rings
 * spaced by `sma^0.45` so the inner system stays clustered (as it really is) and outer-pack
 * planets (Sarnus → Plock under OPM) still get distinct rings without flattening to "every
 * planet at the same distance" the way pure log10 does.
 *
 * Bodies are rendered as circles textured with their basemap SVG (clipped to a disc), giving a
 * crude "planet picture" using assets we already ship under `/maps/{worldId}/{Body}.svg`.
 * Atmospheric bodies get a subtle halo ring sized off `atmosphereDepthM` (visual only).
 *
 * Vessels show as live dots on whichever body their telemetry says they're on. When the caller
 * supplies `vesselOrbits` we additionally draw an approximate orbit ellipse around the parent
 * body using just `apoapsis` and `periapsis` from telemetry — enough to make "LKO looks like
 * LKO" (a tight ring kissing Kerbin) without needing the full set of Keplerian elements. The
 * ellipse SHAPE and SIZE are correct (semi-major / eccentricity derived from Ap+Pe + the body's
 * catalog `radiusM`) but the ORIENTATION on the page is faked from a stable per-vessel hash —
 * we don't have LAN / argument-of-periapsis on the wire yet, so two ships in the same orbit
 * still get distinguishable rings instead of perfectly overlapping. The vessel dot is placed at
 * periapsis; we don't know the true anomaly so animating it would lie. Bodies without a
 * `vesselOrbits` entry fall back to the legacy "ring of pips around the body marker" decoration.
 *
 * Interaction:
 *   - Wheel over the SVG: zoom around the cursor.
 *   - Drag the SVG: pan.
 *   - +/-/Reset buttons: keyboard-friendly zoom controls.
 *   - Click a body: highlight it AND fire `onFocusBody(name)` so callers can sync (e.g. swap
 *     the body map). Clicking also opens an inline details card showing every field the
 *     catalog has for that body — radius, gravity (derived to surface g), SOI, atmosphere,
 *     rotation period, semi-major axis. Clicking the same body again or the close × hides it.
 */

/**
 * Canvas is logical-units only — the SVG scales to its container via viewBox, so making this
 * bigger just buys us more room to space planets apart without changing the on-screen size. We
 * went from 600 to 1000 specifically so the OPM lineup (10+ planets) can sit on evenly-spaced
 * rings with enough radial gap (~45 units) between rings for each planet's moon fan to fit
 * without bleeding into the next ring's planet marker.
 */
const SVG_W = 1000;
const SVG_H = 1000;
const CENTER_X = SVG_W / 2;
const CENTER_Y = SVG_H / 2;
const STAR_R = 18;
const PLANET_R = 7;
const MOON_R = 3.5;
const VESSEL_R = 1.6;
/** Outermost ring radius in SVG units; planets are distributed evenly into [MIN_RING_R, this]. */
const MAX_RING_R = Math.min(SVG_W, SVG_H) / 2 - 30;
const MIN_RING_R = STAR_R + 30;
const MOON_RING_BASE_R = 14;
const MOON_RING_STEP_R = 6;
/**
 * Minimum gap (SVG units) we want between adjacent planet rings. Has to clear the worst-case
 * moon fan: a planet with N moons extends ~MOON_RING_BASE_R + (N-1)·MOON_RING_STEP_R from its
 * marker, plus a planet radius, so 5-moon Sarnus / Jool need ~45 units of clearance to the
 * next ring. Used as a floor when even-spacing collapses (very few planets and a huge canvas
 * would otherwise space them absurdly far apart, which is fine, but very many planets would
 * crush them — the floor side never triggers in practice with current SVG_W=1000).
 */
const MIN_RING_GAP = 45;

/**
 * Initial / "Reset view" zoom. 1× shows the whole system (Moho out to Plock under OPM) at once
 * with the planets already spread onto evenly-spaced rings — that's what users want to see
 * first. They can wheel in to inspect Kerbin's moons or any specific body. The previous 3×
 * default was an accommodation for the old power-curve layout where inner planets were dots
 * piled on the star; with even ring spacing every planet is already readable at 1×.
 */
const DEFAULT_ZOOM = 1;
const DEFAULT_VIEW = {
  x: CENTER_X - SVG_W / (2 * DEFAULT_ZOOM),
  y: CENTER_Y - SVG_H / (2 * DEFAULT_ZOOM),
  w: SVG_W / DEFAULT_ZOOM,
  h: SVG_H / DEFAULT_ZOOM
} as const;

/**
 * One vessel currently in a closed orbit around `bodyName`. Altitudes are above the body's
 * surface (matches `Vessel.orbit.ApA` / `PeA` from the plugin) and must both be ≥ 0 — caller is
 * responsible for filtering out sub-orbital / hyperbolic ships before passing them in.
 */
export type VesselOrbitSpec = {
  /** Stable id used for the ellipse rotation hash so the same craft draws in the same place. */
  id: string;
  /** Body the vessel is orbiting (matches `SystemCatalogBody.name`, case-insensitive lookup). */
  bodyName: string;
  /** Apoapsis altitude above body surface, meters. */
  apoapsisM: number;
  /** Periapsis altitude above body surface, meters. */
  periapsisM: number;
  /** Optional callsign for the SVG title tooltip. */
  callsign?: string;
  /** Highlight this orbit (the viewer's own ship). */
  isSelf?: boolean;
};

type Props = {
  catalog: SystemCatalog;
  /** Vessel counts keyed by body name (case-insensitive). Used to size the body marker. */
  vesselCounts: Map<string, number>;
  /**
   * Optional. Orbit specs grouped by lowercased body name. When present, each body draws a
   * ring of orbit ellipses for the vessels currently captured by it (replacing the decorative
   * pip ring around the body marker for those vessels).
   */
  vesselOrbits?: Map<string, VesselOrbitSpec[]>;
  focusedBodyName: string;
  onFocusBody: (bodyName: string) => void;
};

type LaidOut = {
  body: SystemCatalogBody;
  /** Cartesian center of the body's marker on the schematic. */
  cx: number;
  cy: number;
  /** Markers placed deeper than 1 (moons) get smaller. */
  depth: number;
  /**
   * Where the body's name label hangs relative to the marker.
   *  - `"above"` — centered directly above the marker. Used for planets so the entire
   *    right / bottom / left arc is free for the planet's moons.
   *  - `"right"` / `"left"` — anchored on that side, away from whatever it'd otherwise
   *    collide with (the parent planet for moons, the canvas edge for the star).
   */
  labelPlacement: "above" | "right" | "left";
};

function vesselCountFor(counts: Map<string, number>, bodyName: string): number {
  const lower = bodyName.toLowerCase();
  for (const [k, v] of counts) if (k.toLowerCase() === lower) return v;
  return 0;
}

/**
 * Build a placement map. Planets get spaced angularly around the star; their moons get spaced
 * angularly around the planet. Angle is deterministic by sibling order so the picture stays
 * stable across re-renders even though the underlying motion isn't simulated.
 */
function layoutSystem(catalog: SystemCatalog): LaidOut[] {
  const byParent = new Map<string | null, SystemCatalogBody[]>();
  let star: SystemCatalogBody | null = null;
  for (const b of catalog.bodies) {
    if (b.isStar && !star) star = b;
    const arr = byParent.get(b.parent) ?? [];
    arr.push(b);
    byParent.set(b.parent, arr);
  }
  if (!star) star = catalog.bodies[0] ?? null;

  const out: LaidOut[] = [];
  if (!star) return out;
  out.push({ body: star, cx: CENTER_X, cy: CENTER_Y, depth: 0, labelPlacement: "right" });

  const planets = (byParent.get(star.name) ?? []).slice().sort(
    (a, b) => (a.semiMajorAxisM ?? 0) - (b.semiMajorAxisM ?? 0)
  );

  // Ring radii are EVENLY spaced from MIN_RING_R out to MAX_RING_R. Earlier versions tried to
  // approximate true orbital distance with a power curve (sma^0.7), which produced a clump of
  // overlapping inner planets (Moho/Eve/Kerbin/Duna all kissing each other near the star) and
  // a sparse outer system. Real positions don't matter on this schematic — the player needs to
  // see "where things are relative to each other in the planet list", not navigate by it — so
  // we just give every planet its own ring with at least MIN_RING_GAP units between rings.
  // Sort order still comes from sma so the inner-to-outer reading order is correct.
  const ringStep = Math.max(
    MIN_RING_GAP,
    planets.length > 1
      ? (MAX_RING_R - MIN_RING_R) / (planets.length - 1)
      : MAX_RING_R - MIN_RING_R
  );

  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    if (!p) continue;
    const r = MIN_RING_R + i * ringStep;
    // Stagger angles to spread bodies apart even if they share an SMA bucket. Start above the
    // star (12 o'clock) and walk clockwise.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, planets.length);
    const cx = CENTER_X + r * Math.cos(angle);
    const cy = CENTER_Y + r * Math.sin(angle);
    // Planet labels float ABOVE the marker. The whole bottom + sides arc (right → down → left)
    // is then free for the planet's moons without the label ever drawing on top of one of them.
    out.push({ body: p, cx, cy, depth: 1, labelPlacement: "above" });

    const moons = (byParent.get(p.name) ?? []).slice().sort(
      (a, b) => (a.semiMajorAxisM ?? 0) - (b.semiMajorAxisM ?? 0)
    );
    // Moons fan across the LOWER semicircle of the planet (0 → π/2 → π, i.e. right, down,
    // left). The TOP arc is reserved for the parent planet's name label, which now hangs
    // directly above the marker; moons in the lower semicircle never collide with it. The first
    // moon sits in the lower-right, the middle moon dead-bottom, and the last moon in the
    // lower-left, with each moon on its own ring (`MOON_RING_BASE_R + j*MOON_RING_STEP_R`) so
    // labels can hang off opposite sides without overlapping each other.
    const moonCount = moons.length;
    for (let j = 0; j < moonCount; j++) {
      const m = moons[j];
      if (!m) continue;
      const moonR = MOON_RING_BASE_R + j * MOON_RING_STEP_R;
      const moonAngle = ((j + 1) / (moonCount + 1)) * Math.PI;
      const moonCx = cx + moonR * Math.cos(moonAngle);
      const moonCy = cy + moonR * Math.sin(moonAngle);
      // Moon label hangs on the side opposite the parent planet so the text never draws back
      // over the planet marker. Lower-right moons get a right-anchored label; lower-left moons
      // get a left-anchored one. The dead-bottom moon (cos≈0) defaults to the right.
      const labelPlacement: "right" | "left" = moonCx < cx ? "left" : "right";
      out.push({ body: m, cx: moonCx, cy: moonCy, depth: 2, labelPlacement });
    }
  }

  return out;
}

/** Engineering-notation "1.2 Gm", "535 km", etc. for distances. Keeps the details card compact. */
function formatDistance(meters: number | null | undefined): string {
  if (meters == null || !isFinite(meters)) return "—";
  const abs = Math.abs(meters);
  if (abs >= 1e9) return `${(meters / 1e9).toFixed(2)} Gm`;
  if (abs >= 1e6) return `${(meters / 1e6).toFixed(2)} Mm`;
  if (abs >= 1e3) return `${(meters / 1e3).toFixed(1)} km`;
  return `${meters.toFixed(0)} m`;
}

function formatSeconds(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "—";
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(2)} h`;
  return `${(s / 86400).toFixed(2)} d`;
}

/**
 * Surface gravity from gravity parameter (μ = GM) and radius. g = μ / r². Returned in m/s² and
 * also as Earth-g multiples since players think in g's. `null` when either input is missing.
 */
function surfaceGravity(body: SystemCatalogBody): { ms2: number; gees: number } | null {
  const mu = body.gravityParameterM3S2;
  const r = body.radiusM;
  if (!mu || !r || r <= 0) return null;
  const ms2 = mu / (r * r);
  return { ms2, gees: ms2 / 9.80665 };
}

/**
 * Per-body atmosphere ring radius in SVG units. Real atmosphere depth would be invisible at
 * this scale (Kerbin: 70 km vs 600 km radius → 11% halo) so we exaggerate slightly (×1.5) and
 * cap at +60% of body radius so gas giants don't swallow neighbors.
 */
function atmosphereHaloRadius(baseR: number, body: SystemCatalogBody): number | null {
  if (!body.hasAtmosphere || !body.atmosphereDepthM || !body.radiusM) return null;
  const fraction = body.atmosphereDepthM / body.radiusM;
  return baseR * (1 + Math.min(0.6, fraction * 1.5));
}

/**
 * Map an orbital ALTITUDE (m above body surface) onto an SVG offset from the body marker's
 * surface. Goal: LKO (Kerbin Pe ≈ 80 km vs 600 km radius) renders as a ring just outside the
 * atmosphere halo — visibly an orbit, not a planet decoration — while geostationary altitude
 * (~2868 km on Kerbin) is clearly farther out, and SOI-grazing orbits don't blow off the canvas.
 *
 * Curve:  offset = baseR · 0.9 · log10(1 + 8 · altM/radiusM)
 *
 * Numbers it produces around Kerbin (baseR=7, radius=600 km):
 *   - Atmosphere halo top ≈ 8.2 svg
 *   - LKO  (80 km)    →  8.98 svg  (just outside the halo, exactly what you want)
 *   - HKO  (200 km)   → 10.55 svg
 *   - KEO  (2868 km)  → 17.04 svg
 *   - Mun-distance    → ~21 svg
 *   - SOI-grazing     → ~26 svg (clamped further by `MAX_OFFSET_RATIO` below)
 *
 * Returns 0 (collapses to body surface) if altM ≤ 0 or radiusM is missing.
 */
function altitudeOffsetSvg(altM: number, bodyRadiusM: number, baseR: number): number {
  if (altM <= 0 || bodyRadiusM <= 0) return 0;
  const ratio = altM / bodyRadiusM;
  const compressed = Math.log10(1 + 8 * ratio);
  /** Hard ceiling so an "orbit" the size of an SOI doesn't span half the canvas. */
  const MAX_OFFSET_RATIO = 4;
  return Math.min(baseR * MAX_OFFSET_RATIO, baseR * 0.9 * compressed);
}

/**
 * Stable [0, 360) rotation derived from the vessel id. Without LAN / argument-of-periapsis on
 * the wire we have to fake the orientation; hashing the id keeps the same craft drawing in the
 * same place across re-renders, and the rotation jitter prevents two ships in identical orbits
 * from rendering as the same line.
 */
function hashRotationDeg(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

function vesselOrbitsFor(
  byBody: Map<string, VesselOrbitSpec[]> | undefined,
  bodyName: string
): VesselOrbitSpec[] {
  if (!byBody || byBody.size === 0) return [];
  const lower = bodyName.toLowerCase();
  const direct = byBody.get(lower);
  if (direct) return direct;
  // Defensive: caller may have keyed by display-cased name. Fall back to a full scan once,
  // since these maps are small (one entry per occupied body).
  for (const [k, v] of byBody) if (k.toLowerCase() === lower) return v;
  return [];
}

export function SystemSchematic({
  catalog,
  vesselCounts,
  vesselOrbits,
  focusedBodyName,
  onFocusBody
}: Props): JSX.Element {
  const placements = useMemo(() => layoutSystem(catalog), [catalog]);
  const focusedLower = focusedBodyName.toLowerCase();

  // Pan/zoom state. The viewBox is `[vbX, vbY, vbW, vbH]` in SVG units; `scale` only exists
  // for the readout/buttons. All interaction math operates on the viewBox directly so cursor
  // anchoring "just works" (the SVG point under the cursor before a wheel-zoom is the same
  // SVG point under the cursor after, like Google Maps / Figma / every map library).
  //
  // Default zoom is 3× centered on the star: at 1× the inner planets are tiny dots and the
  // first thing every user did was hit the "+" button three times. Pre-zooming gives Moho /
  // Eve / Kerbin / Mun room to actually be readable on first paint.
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number }>(
    () => DEFAULT_VIEW
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: { x: number; y: number; w: number; h: number };
    moved: boolean;
  } | null>(null);

  // Inline details card state. `null` = no card. We seed it from `focusedBodyName` if present
  // (so callers that pre-select a body open the card too) but allow the user to close it.
  const [detailsBodyName, setDetailsBodyName] = useState<string | null>(focusedBodyName || null);

  const { x: vbX, y: vbY, w: vbW, h: vbH } = view;
  const scale = SVG_W / vbW;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 40;

  // Wheel listener registered manually with `{ passive: false }` because React's synthetic
  // onWheel is passive in modern browsers — calling preventDefault on the synthetic event is
  // a no-op and the page scrolls behind the schematic. Native non-passive listener fixes that.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Capture the wheel-event values up-front; the setter runs async and `e` may have been
      // pooled / nulled-out by the time React schedules it.
      const clientX = e.clientX;
      const clientY = e.clientY;
      // Smooth-ish exponential zoom; trackpad pixel deltas and mouse "line" deltas both feel
      // OK with this curve. Negative deltaY = zoom in.
      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        // Convert the client-pixel cursor into SVG userspace using the LIVE view (`v`), not the
        // closure-captured `vbX/vbY/vbW/vbH`. The previous implementation called `clientToSvg`
        // before `setView`, which closed over the *first render's* viewBox values; after any
        // zoom or pan those go stale and the anchor math drifted the canvas on every wheel
        // event. Inlining keeps the cursor projection in lock-step with the view we're about
        // to mutate, so the SVG point under the cursor truly stays put across the zoom step.
        const vbAspect = v.w / v.h;
        const rectAspect = rect.width / rect.height;
        let drawW = rect.width;
        let drawH = rect.height;
        let offsetX = 0;
        let offsetY = 0;
        if (rectAspect > vbAspect) {
          drawW = rect.height * vbAspect;
          offsetX = (rect.width - drawW) / 2;
        } else {
          drawH = rect.width / vbAspect;
          offsetY = (rect.height - drawH) / 2;
        }
        const localX = clientX - rect.left - offsetX;
        const localY = clientY - rect.top - offsetY;
        // If the cursor is in the letterbox area (outside the actually-drawn SVG), fall back
        // to anchoring on the view's center so we still zoom but don't yank the canvas toward
        // a meaningless point.
        const cursorInside =
          localX >= 0 && localX <= drawW && localY >= 0 && localY <= drawH;
        const cursorX = cursorInside ? v.x + (localX / drawW) * v.w : v.x + v.w / 2;
        const cursorY = cursorInside ? v.y + (localY / drawH) * v.h : v.y + v.h / 2;

        const currentScale = SVG_W / v.w;
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, currentScale * zoomFactor));
        const ratio = currentScale / nextScale; // = newW / oldW
        const newW = v.w * ratio;
        const newH = v.h * ratio;
        const newX = cursorX - ((cursorX - v.x) * newW) / v.w;
        const newY = cursorY - ((cursorY - v.y) * newH) / v.h;
        return { x: newX, y: newY, w: newW, h: newH };
      });
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startView: { ...view },
      moved: false
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // Use the same letterboxed draw rect logic as clientToSvg so 1 client-pixel of mouse
    // motion translates to exactly 1 client-pixel of canvas motion at the current zoom.
    const vbAspect = d.startView.w / d.startView.h;
    const rectAspect = rect.width / rect.height;
    const drawW = rectAspect > vbAspect ? rect.height * vbAspect : rect.width;
    const drawH = rectAspect > vbAspect ? rect.height : rect.width / vbAspect;
    const dxClient = e.clientX - d.startClientX;
    const dyClient = e.clientY - d.startClientY;
    const dxSvg = (dxClient / drawW) * d.startView.w;
    const dySvg = (dyClient / drawH) * d.startView.h;
    if (Math.abs(dxClient) + Math.abs(dyClient) > 3) d.moved = true;
    setView({
      x: d.startView.x - dxSvg,
      y: d.startView.y - dySvg,
      w: d.startView.w,
      h: d.startView.h
    });
  };

  const endPointerDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    // Keep `moved` readable for the immediately-following click handler, then clear next tick.
    const wasMoved = d.moved;
    dragRef.current = { ...d, moved: wasMoved };
    setTimeout(() => {
      if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    }, 0);
  };

  const resetView = () => {
    setView(DEFAULT_VIEW);
  };

  /** Programmatic zoom (buttons). Anchors on canvas center since there's no cursor involved. */
  const zoomBy = (factor: number) => {
    setView((v) => {
      const currentScale = SVG_W / v.w;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, currentScale * factor));
      const ratio = currentScale / nextScale;
      const newW = v.w * ratio;
      const newH = v.h * ratio;
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  };

  const handleBodyClick = (body: SystemCatalogBody) => {
    // Suppress click after a drag so panning doesn't accidentally select planets.
    if (dragRef.current?.moved) return;
    onFocusBody(body.name);
    setDetailsBodyName((prev) =>
      prev && prev.toLowerCase() === body.name.toLowerCase() ? null : body.name
    );
  };

  const detailsBody = useMemo(() => {
    if (!detailsBodyName) return null;
    const lower = detailsBodyName.toLowerCase();
    return catalog.bodies.find((b) => b.name.toLowerCase() === lower) ?? null;
  }, [catalog, detailsBodyName]);

  // Pre-compute orbital ring radii for the star's children so we can draw them as guide circles.
  const ringRadii = useMemo(() => {
    const planets = placements.filter((p) => p.depth === 1);
    return planets.map((p) => {
      const dx = p.cx - CENTER_X;
      const dy = p.cy - CENTER_Y;
      return Math.sqrt(dx * dx + dy * dy);
    });
  }, [placements]);

  return (
    <div className="system-schematic" role="img" aria-label={`${catalog.displayName} overview`}>
      <div className="system-schematic-header">
        <strong>{catalog.displayName}</strong>
        <span className="system-schematic-hint">Wheel to zoom · drag to pan · click a body</span>
      </div>

      <div className="system-schematic-canvas-wrap">
        <svg
          ref={svgRef}
          viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
          preserveAspectRatio="xMidYMid meet"
          className="system-schematic-svg"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
        >
          <defs>
            {/* One clip path per body lets us crop the equirectangular basemap into a disc.
                Radii here intentionally match the body's draw radius below. */}
            {placements.map(({ body, depth }) => {
              const r = body.isStar ? STAR_R : depth === 1 ? PLANET_R : MOON_R;
              return (
                <clipPath
                  key={`clip-${body.name}`}
                  id={`schematic-clip-${body.name.replace(/[^a-z0-9]/gi, "_")}`}
                  clipPathUnits="userSpaceOnUse"
                >
                  <circle cx={0} cy={0} r={r} />
                </clipPath>
              );
            })}
            <radialGradient id="schematic-star-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fde68a" />
              <stop offset="60%" stopColor="#facc15" />
              <stop offset="100%" stopColor="#b45309" />
            </radialGradient>
            <radialGradient id="schematic-shade" cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
              <stop offset="60%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
            </radialGradient>
          </defs>

          <g
            className="system-schematic-rings"
            stroke="rgba(148, 163, 184, 0.22)"
            strokeWidth={0.5}
            fill="none"
          >
            {ringRadii.map((r, i) => (
              <circle key={`ring-${i}`} cx={CENTER_X} cy={CENTER_Y} r={r} />
            ))}
          </g>

          {placements.map(({ body, cx, cy, depth, labelPlacement }) => {
            const isFocused = body.name.toLowerCase() === focusedLower;
            const isDetails =
              detailsBody && body.name.toLowerCase() === detailsBody.name.toLowerCase();
            const count = vesselCountFor(vesselCounts, body.name);
            const baseR = body.isStar ? STAR_R : depth === 1 ? PLANET_R : MOON_R;
            const clipId = `schematic-clip-${body.name.replace(/[^a-z0-9]/gi, "_")}`;
            const halo = atmosphereHaloRadius(baseR, body);
            // Stars use the gradient; everyone else uses the basemap texture. The basemap is a
            // 2:1 equirectangular SVG; we scale it 2× wider than tall and let the circle clip
            // pull the equator slice. Missing files just render as a transparent circle (the
            // browser swallows the 404), and the stroke + shade gradient still convey "this
            // is a body, not background".
            const basemapHref = body.isStar ? null : basemapUrlFor(catalog.worldId, body.name);
            // Selection ring (clicked-for-details) takes precedence over focus ring color.
            const ringColor = isDetails ? "#22d3ee" : isFocused ? "#fde68a" : "rgba(15, 23, 42, 0.85)";
            const ringWidth = isDetails ? 1.6 : isFocused ? 1.4 : 0.6;
            // Translate the abstract label placement into concrete SVG attributes. "above" puts
            // the baseline far enough above the marker that the text bottom (incl. descenders)
            // clears the body ring; "right" / "left" sit alongside the marker on that side.
            let labelDx = 0;
            let labelDy = 1.8;
            let labelAnchor: "start" | "middle" | "end" = "start";
            if (labelPlacement === "right") {
              labelDx = baseR + 3;
              labelAnchor = "start";
            } else if (labelPlacement === "left") {
              labelDx = -(baseR + 3);
              labelAnchor = "end";
            } else {
              labelDx = 0;
              labelDy = -(baseR + 2);
              labelAnchor = "middle";
            }
            return (
              <g
                key={body.name}
                transform={`translate(${cx} ${cy})`}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleBodyClick(body);
                }}
              >
                {halo != null ? (
                  <circle
                    r={halo}
                    fill="rgba(125, 211, 252, 0.18)"
                    stroke="rgba(125, 211, 252, 0.45)"
                    strokeWidth={0.4}
                  />
                ) : null}

                {body.isStar ? (
                  <circle r={baseR} fill="url(#schematic-star-glow)" />
                ) : basemapHref ? (
                  <>
                    <circle r={baseR} fill="#1e293b" />
                    <image
                      href={basemapHref}
                      x={-baseR}
                      y={-baseR}
                      width={baseR * 2}
                      height={baseR * 2}
                      preserveAspectRatio="xMidYMid slice"
                      clipPath={`url(#${clipId})`}
                    />
                    <circle r={baseR} fill="url(#schematic-shade)" />
                  </>
                ) : (
                  <circle r={baseR} fill={depth === 1 ? "#60a5fa" : "#94a3b8"} />
                )}

                <circle r={baseR} fill="none" stroke={ringColor} strokeWidth={ringWidth} />

                {count > 0 ? (
                  <g>
                    <circle
                      cx={baseR * 0.85}
                      cy={-baseR * 0.85}
                      r={Math.max(2.4, Math.min(4, 1.5 + Math.log2(count + 1)))}
                      fill="#22c55e"
                      stroke="#0f172a"
                      strokeWidth={0.4}
                    />
                    <text
                      x={baseR * 0.85}
                      y={-baseR * 0.85 + 1.3}
                      fontSize={3}
                      fill="#0f172a"
                      textAnchor="middle"
                    >
                      {count}
                    </text>
                  </g>
                ) : null}

                <text
                  x={labelDx}
                  y={labelDy}
                  fontSize={5.5}
                  fill="#e5e7eb"
                  stroke="#0f172a"
                  strokeWidth={0.3}
                  paintOrder="stroke"
                  textAnchor={labelAnchor}
                >
                  {body.displayName}
                </text>

                {/* Orbit ellipses for any vessel known to be captured by this body. Each ellipse
                    is positioned with the body at one focus: center at (-c, 0), so periapsis sits
                    at +x = +r_pe and apoapsis at -x = -r_ap relative to the body, then the whole
                    group is rotated by a per-vessel hash to spread overlapping rings apart. */}
                {(() => {
                  const orbits = vesselOrbitsFor(vesselOrbits, body.name);
                  if (orbits.length === 0 || !body.radiusM) return null;
                  return orbits.map((vo) => {
                    if (!(vo.apoapsisM > 0) || !(vo.periapsisM >= 0)) return null;
                    const rApSvg = baseR + altitudeOffsetSvg(vo.apoapsisM, body.radiusM, baseR);
                    const rPeSvg = baseR + altitudeOffsetSvg(vo.periapsisM, body.radiusM, baseR);
                    if (rApSvg < rPeSvg) return null; // numeric guard
                    const a = (rApSvg + rPeSvg) / 2;
                    const c = (rApSvg - rPeSvg) / 2;
                    const b = Math.sqrt(Math.max(0, rApSvg * rPeSvg));
                    const rot = hashRotationDeg(vo.id);
                    const stroke = vo.isSelf ? "#22c55e" : "#38bdf8";
                    return (
                      <g key={`orbit-${vo.id}`} transform={`rotate(${rot})`} pointerEvents="none">
                        <ellipse
                          cx={-c}
                          cy={0}
                          rx={a}
                          ry={b}
                          fill="none"
                          stroke={stroke}
                          strokeOpacity={0.7}
                          strokeWidth={0.5}
                        />
                        <circle
                          cx={rPeSvg}
                          cy={0}
                          r={VESSEL_R + 0.2}
                          fill={stroke}
                          stroke="#0f172a"
                          strokeWidth={0.3}
                        >
                          {vo.callsign ? <title>{vo.callsign}</title> : null}
                        </circle>
                      </g>
                    );
                  });
                })()}

                {/* Visualize that vessels are physically here without doing real orbit math. A small
                    ring of vessel pips around the body marker is enough to communicate "stuff here".
                    Suppressed when the body already has explicit orbit specs — those vessels are
                    represented by the orbit dot at periapsis above, so a duplicate pip ring would
                    just clutter the picture and double-count. */}
                {count > 0 && vesselOrbitsFor(vesselOrbits, body.name).length === 0
                  ? Array.from({ length: Math.min(count, 6) }).map((_, i) => {
                      const a = (i / Math.min(count, 6)) * 2 * Math.PI - Math.PI / 2;
                      const r = baseR + 4;
                      return (
                        <circle
                          key={`v-${i}`}
                          cx={r * Math.cos(a)}
                          cy={r * Math.sin(a)}
                          r={VESSEL_R}
                          fill="#22c55e"
                          stroke="#0f172a"
                          strokeWidth={0.3}
                        />
                      );
                    })
                  : null}
              </g>
            );
          })}
        </svg>

        <div className="system-schematic-controls" aria-label="Zoom controls">
          <button type="button" onClick={() => zoomBy(1.4)} title="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.4)} title="Zoom out">
            −
          </button>
          <button type="button" onClick={resetView} title="Reset view">
            ⟲
          </button>
          <span className="system-schematic-zoom-readout">{scale.toFixed(2)}×</span>
        </div>
      </div>

      {detailsBody ? (
        <BodyDetailsCard
          body={detailsBody}
          worldId={catalog.worldId}
          onClose={() => setDetailsBodyName(null)}
        />
      ) : null}
    </div>
  );
}

function BodyDetailsCard({
  body,
  worldId,
  onClose
}: {
  body: SystemCatalogBody;
  worldId: string;
  onClose: () => void;
}): JSX.Element {
  const g = surfaceGravity(body);
  const kind = body.isStar ? "Star" : body.parent ? "Moon / Body" : "Planet";
  // The card's "picture" reuses the same equirectangular basemap clipped to a disc; if the
  // file is missing the browser swallows the 404 and we fall back to the colored placeholder.
  const pictureHref = body.isStar ? null : basemapUrlFor(worldId, body.name);

  return (
    <div className="system-schematic-details">
      <button
        type="button"
        className="system-schematic-details-close"
        onClick={onClose}
        title="Close"
        aria-label="Close details"
      >
        ×
      </button>

      <div className="system-schematic-details-picture" aria-hidden>
        {body.isStar ? (
          <div
            className="system-schematic-details-disc"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, #fde68a 0%, #facc15 60%, #b45309 100%)"
            }}
          />
        ) : pictureHref ? (
          <div
            className="system-schematic-details-disc"
            style={{
              backgroundImage: `url(${pictureHref})`,
              backgroundSize: "cover",
              backgroundPosition: "center"
            }}
          />
        ) : (
          <div className="system-schematic-details-disc" style={{ background: "#1e293b" }} />
        )}
      </div>

      <div className="system-schematic-details-info">
        <div className="system-schematic-details-title">
          <strong>{body.displayName}</strong>
          <span className="system-schematic-details-kind">{kind}</span>
        </div>

        <dl className="system-schematic-details-grid">
          {body.parent ? (
            <>
              <dt>Orbits</dt>
              <dd>{body.parent}</dd>
            </>
          ) : null}
          <dt>Radius</dt>
          <dd>{formatDistance(body.radiusM)}</dd>
          {g ? (
            <>
              <dt>Surface g</dt>
              <dd>
                {g.ms2.toFixed(2)} m/s² ({g.gees.toFixed(2)} g)
              </dd>
            </>
          ) : null}
          {body.gravityParameterM3S2 ? (
            <>
              <dt>μ (GM)</dt>
              <dd>{body.gravityParameterM3S2.toExponential(3)} m³/s²</dd>
            </>
          ) : null}
          <dt>Atmosphere</dt>
          <dd>
            {body.hasAtmosphere
              ? body.atmosphereDepthM
                ? `Yes — ${formatDistance(body.atmosphereDepthM)} deep`
                : "Yes"
              : "None"}
          </dd>
          <dt>Rotation period</dt>
          <dd>{formatSeconds(body.rotationPeriodSec)}</dd>
          {body.sphereOfInfluenceM != null ? (
            <>
              <dt>SOI</dt>
              <dd>{formatDistance(body.sphereOfInfluenceM)}</dd>
            </>
          ) : null}
          {body.semiMajorAxisM != null && body.semiMajorAxisM > 0 ? (
            <>
              <dt>Semi-major axis</dt>
              <dd>{formatDistance(body.semiMajorAxisM)}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
