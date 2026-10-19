/**
 * Some historical Kerbin SVG plates used a cropped root `viewBox` (50 106.5
 * 702.25 351.5) instead of the tower overlay box. Map overlays assume
 * `0 … KERBIN_MAP_VB_W` × `0 … KERBIN_MAP_VB_H` (see `latLonToMapVB`). This
 * helper rewrites that pattern when present so injected terrain aligns with
 * graticule and navaid math.
 */
export const KERBIN_MAP_VB_W = 596;
export const KERBIN_MAP_VB_H = 298;
export const KERBIN_MAP_PRESERVE_ASPECT = "xMidYMid meet" as const;

/** Root viewBox on legacy cropped Kerbin vector basemap SVGs (historical asset layout). */
const LEGACY_CROP_VB_X = 50;
const LEGACY_CROP_VB_Y = 106.5;
const LEGACY_CROP_VB_W = 702.25;
const LEGACY_CROP_VB_H = 351.5;

const LEGACY_CROP_VIEWBOX_RE = /\bviewBox\s*=\s*["']50\s+106\.5\s+702\.25\s+351\.5["']/i;

/** Map cropped-plate user space into the overlay viewBox (0…W × 0…H). */
function legacyCropPlateToOverlayMatrix(): string {
  const sx = KERBIN_MAP_VB_W / LEGACY_CROP_VB_W;
  const sy = KERBIN_MAP_VB_H / LEGACY_CROP_VB_H;
  const e = -LEGACY_CROP_VB_X * sx;
  const f = -LEGACY_CROP_VB_Y * sy;
  return `matrix(${sx} 0 0 ${sy} ${e} ${f})`;
}

export function patchKerbinTerrainSvgRoot(
  svg: string,
  preserveAspectRatio: string = KERBIN_MAP_PRESERVE_ASPECT
): string {
  // XML declaration is not valid in HTML fragment parsing; some browsers drop
  // the whole subtree when `innerHTML` starts with `<?xml …?>`.
  let out = svg.replace(/^\s*<\?xml\b[^?]*\?>\s*/i, "");
  const rootMatch = /<svg\b[^>]*>/i.exec(out);
  if (!rootMatch || rootMatch.index == null) return out;

  const rootTag = rootMatch[0];
  let patchedRootTag = rootTag;
  let legacyCropMatrix: string | null = null;
  if (LEGACY_CROP_VIEWBOX_RE.test(rootTag)) {
    legacyCropMatrix = legacyCropPlateToOverlayMatrix();
    patchedRootTag = patchedRootTag.replace(
      LEGACY_CROP_VIEWBOX_RE,
      `viewBox="0 0 ${KERBIN_MAP_VB_W} ${KERBIN_MAP_VB_H}"`
    );
  }

  const aspectAttribute = /\s+preserveAspectRatio\s*=\s*["'][^"']*["']/i;
  patchedRootTag = aspectAttribute.test(patchedRootTag)
    ? patchedRootTag.replace(aspectAttribute, ` preserveAspectRatio="${preserveAspectRatio}"`)
    : patchedRootTag.replace(/(\/?>)$/, ` preserveAspectRatio="${preserveAspectRatio}"$1`);

  const rootOpenExtra = legacyCropMatrix ? `<g transform="${legacyCropMatrix}">` : "";
  out = `${out.slice(0, rootMatch.index)}${patchedRootTag}${rootOpenExtra}${out.slice(
    rootMatch.index + rootTag.length
  )}`;
  if (legacyCropMatrix) {
    // A `transform` on the root `<svg>` is not reliably composed with `viewBox`
    // the same way as an inner `<g>` — root transform was shifting the plate to
    // the wrong hemisphere. Wrap all plate geometry instead.
    const end = out.lastIndexOf("</svg>");
    if (end >= 0) {
      out = `${out.slice(0, end)}</g>${out.slice(end)}`;
    }
  }
  return out;
}
