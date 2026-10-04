import { useMemo, useState } from "react";
import { queryKeys } from "../query/client";
import { useApiQuery, ApiError } from "../query/hooks";

/**
 * Vessel Schematic panel: renders an SVG schematic of the active vessel from
 * the per-vessel parts manifest the KSP plugin uploads. Backend route is
 * `GET /v1/tower/vessel-schematic/{sessionId}`; the manifest itself ships
 * once per vessel-load event (and again on stage / dock / undock) so this
 * panel polls slowly and trusts the cache.
 *
 * Why SVG and not bitmap:
 *   - Scales cleanly with the controller's panel grid resize.
 *   - Tooltips on individual parts are basically free (`<title>` element).
 *   - Live tank-fill / hot-part overlays in Phase 4 are SVG attribute updates
 *     instead of a re-encode round-trip.
 *
 * Empty / 404 / loading are handled inline so the card stays present in the
 * layout — same pattern as `TowerViewPanel`. We deliberately don't render
 * `null` on missing data because the controller needs the affordance ("oh,
 * the schematic isn't here yet because the pilot hasn't launched") rather
 * than a silent gap.
 */

// Slow refetch — manifest only changes on vessel-modify events on the
// publisher side, and the publisher itself debounces to ~one POST per
// staging cluster. 8 s gives controllers a "switched stages, refresh"
// feel without flogging the backend.
const SCHEMATIC_POLL_MS = 8_000;

// Two top-down projections side by side. Width:height ratio is chosen so
// the SVG fills the card without aggressive letter-boxing for typical
// rocket-ish aspect ratios; long aircraft will letterbox horizontally,
// which is fine.
const SVG_VIEW_W = 600;
const SVG_VIEW_H = 320;
const PANEL_PAD = 12;

type ManifestPart = {
  i: number;
  n: string;
  /** [x, y, z] vessel-local position relative to root, metres. */
  p: [number, number, number];
  /** [x, y, z, w] vessel-local rotation. Currently unused by the renderer
   * (parts are drawn axis-aligned to root frame); kept on the wire so a
   * future pass can rotate the part rectangle. */
  r: [number, number, number, number];
  /** Axis-aligned bounds extents, metres. */
  b: [number, number, number];
  /** Dry mass tonnes. */
  m: number;
  /** Manifest index of parent; -1 for root. */
  parent: number;
  /** inverseStage. */
  stage: number;
  tags: string[];
};

type VesselManifest = {
  persistentId: string;
  craftName: string;
  craftMapIcon: string;
  rootPartIndex: number;
  truncated: boolean;
  parts: ManifestPart[];
};

type SchematicResponse = {
  ok: true;
  sessionId: string;
  uploadedAtMs: number;
  serverNowMs: number;
  idleTtlMs: number;
  manifest: VesselManifest;
};

type Projection = "top" | "side";

export function VesselSchematicPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const q = useApiQuery<SchematicResponse>({
    queryKey: queryKeys.tower.vesselSchematic(sessionId),
    path: `/v1/tower/vessel-schematic/${encodeURIComponent(sessionId)}`,
    refetchInterval: SCHEMATIC_POLL_MS,
    placeholderData: (prev) => prev,
    // 404 = "no manifest yet" — that's the expected pre-launch state, not
    // something to retry. Anything else (5xx, network) goes through the
    // global retry policy.
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 1;
    },
    enabled: !!sessionId
  });

  const [projection, setProjection] = useState<Projection>("top");

  const manifest = q.data?.manifest ?? null;

  return (
    <section className="vessel-schematic-panel" aria-label="Vessel schematic">
      <header className="vessel-schematic-panel__head">
        <h3 className="vessel-schematic-panel__title">VESSEL SCHEMATIC</h3>
        <span className="vessel-schematic-panel__sub">
          {manifest
            ? `${manifest.parts.length} part${manifest.parts.length === 1 ? "" : "s"}${
                manifest.truncated ? " (truncated)" : ""
              }`
            : "—"}
        </span>
      </header>

      {manifest ? (
        <>
          <SchematicSvg manifest={manifest} projection={projection} />
          <div className="vessel-schematic-panel__controls">
            <ProjectionToggle value={projection} onChange={setProjection} />
            <span className="vessel-schematic-panel__craft" title={manifest.persistentId}>
              {manifest.craftName}
            </span>
          </div>
        </>
      ) : (
        <SchematicEmpty
          isFetching={q.isFetching}
          status={q.error instanceof ApiError ? q.error.status : null}
          sessionId={sessionId}
        />
      )}
    </section>
  );
}

function ProjectionToggle({
  value,
  onChange
}: {
  value: Projection;
  onChange: (v: Projection) => void;
}): JSX.Element {
  return (
    <div className="vessel-schematic-panel__projection" role="tablist" aria-label="Schematic view">
      {(["top", "side"] as Projection[]).map((p) => {
        const active = p === value;
        return (
          <button
            type="button"
            key={p}
            role="tab"
            aria-selected={active}
            className={"vessel-schematic-panel__pick" + (active ? " is-active" : "")}
            onClick={() => onChange(p)}
          >
            {p === "top" ? "Top" : "Side"}
          </button>
        );
      })}
    </div>
  );
}

function SchematicEmpty({
  isFetching,
  status,
  sessionId
}: {
  isFetching: boolean;
  status: number | null;
  sessionId: string;
}): JSX.Element {
  if (status === 404) {
    return (
      <p className="vessel-schematic-panel__empty">
        No manifest published for <code>{sessionId || "—"}</code> yet. The schematic appears
        once the pilot loads a vessel in Flight scene with the plugin installed.
      </p>
    );
  }
  if (isFetching) {
    return (
      <p className="vessel-schematic-panel__empty">Loading vessel schematic…</p>
    );
  }
  return (
    <p className="vessel-schematic-panel__empty">
      Schematic unavailable.{" "}
      {status != null ? <span>(HTTP {status})</span> : "Backend unreachable."}
    </p>
  );
}

/**
 * Pure-SVG schematic. Two-pass:
 *   1. compute layout (per-part 2D rect in metres in the chosen projection)
 *      and the global bounding rect.
 *   2. emit `<g>` with a viewBox that fits the bounds, and within it a `<rect>`
 *      per part plus parent-child connector lines so disconnected sub-trees
 *      are visually obvious.
 */
function SchematicSvg({
  manifest,
  projection
}: {
  manifest: VesselManifest;
  projection: Projection;
}): JSX.Element {
  // Project a 3D vessel-local point into 2D (metres). Two conventions
  // collide here: SVG's +y axis points DOWN, while KSP/Unity's +y points
  // UP and +z points FORWARD. We negate the second component so the
  // schematic renders the way a controller expects: rocket nose toward
  // the top of the tile in side view, plane nose toward the top in top
  // view. Root sits at origin so the canvas re-centres in `buildLayout`
  // without further offsetting here.
  const project = (p: [number, number, number]): [number, number] =>
    projection === "top" ? [p[0], -p[2]] : [p[0], -p[1]];

  // `project` is closure-stable per `projection` value; recomputing the
  // layout when either input changes is sufficient.
  const layout = useMemo(
    () => buildLayout(manifest, projection, project),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, projection]
  );

  return (
    <div className="vessel-schematic-panel__svg-wrap">
      <svg
        className="vessel-schematic-panel__svg"
        viewBox={`${-SVG_VIEW_W / 2} ${-SVG_VIEW_H / 2} ${SVG_VIEW_W} ${SVG_VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Schematic of ${manifest.craftName}`}
      >
        <rect
          x={-SVG_VIEW_W / 2 + 1}
          y={-SVG_VIEW_H / 2 + 1}
          width={SVG_VIEW_W - 2}
          height={SVG_VIEW_H - 2}
          fill="rgb(8 13 22)"
          stroke="rgb(255 255 255 / 0.06)"
          strokeWidth={1}
        />

        <g transform={`scale(${layout.scale} ${layout.scale}) translate(${-layout.cx} ${-layout.cy})`}>
          {/* Parent → child connectors first so the rectangles paint over them. */}
          {layout.parts.map((rp) => {
            const parentIdx = manifest.parts[rp.idx]?.parent ?? -1;
            if (parentIdx < 0) return null;
            const parentRP = layout.parts[parentIdx];
            if (!parentRP) return null;
            return (
              <line
                key={`conn-${rp.idx}`}
                x1={parentRP.cx}
                y1={parentRP.cy}
                x2={rp.cx}
                y2={rp.cy}
                stroke="rgb(255 255 255 / 0.18)"
                strokeWidth={Math.max(0.02, 0.04 / layout.scale)}
              />
            );
          })}

          {/* Part rectangles, painted root-first so larger structural parts
              don't clip detail bits in mod stacks. */}
          {[...layout.parts]
            .sort((a, b) => b.area - a.area)
            .map((rp) => {
              const part = manifest.parts[rp.idx]!;
              const fill = pickFill(part);
              const stroke = pickStroke(part);
              return (
                <rect
                  key={`p-${rp.idx}`}
                  x={rp.cx - rp.w / 2}
                  y={rp.cy - rp.h / 2}
                  width={rp.w}
                  height={rp.h}
                  fill={fill}
                  fillOpacity={0.78}
                  stroke={stroke}
                  strokeWidth={Math.max(0.02, 0.05 / layout.scale)}
                  rx={Math.min(rp.w, rp.h) * 0.15}
                  ry={Math.min(rp.w, rp.h) * 0.15}
                >
                  <title>
                    {`${part.n}\nstage ${part.stage}\nmass ${part.m.toFixed(2)} t${
                      part.tags.length ? `\ntags: ${part.tags.join(", ")}` : ""
                    }`}
                  </title>
                </rect>
              );
            })}

          {/* Root marker so the controller can orient (where's the cockpit?). */}
          {layout.parts[manifest.rootPartIndex] ? (
            <circle
              cx={layout.parts[manifest.rootPartIndex]!.cx}
              cy={layout.parts[manifest.rootPartIndex]!.cy}
              r={Math.max(0.08, 0.2 / layout.scale)}
              fill="rgb(255 220 100)"
              stroke="rgb(40 30 0)"
              strokeWidth={Math.max(0.02, 0.04 / layout.scale)}
            />
          ) : null}
        </g>
      </svg>
    </div>
  );
}

type RenderedPart = {
  idx: number;
  /** Centre x in metres (vessel-local, projected). */
  cx: number;
  /** Centre y in metres (vessel-local, projected). */
  cy: number;
  /** Rectangle width in metres. */
  w: number;
  /** Rectangle height in metres. */
  h: number;
  /** Area in m² — used to z-order the painter. */
  area: number;
};

type Layout = {
  parts: RenderedPart[];
  /** Centre of the bounding box (metres) — used to recentre the group transform. */
  cx: number;
  cy: number;
  /** Pixels-per-metre scale that fits the layout in the view box. */
  scale: number;
};

function buildLayout(
  manifest: VesselManifest,
  projection: Projection,
  project: (p: [number, number, number]) => [number, number]
): Layout {
  const parts: RenderedPart[] = [];
  // Treat very small extents (dust covers, RCS jets) as a minimum viewable
  // square so they don't disappear at extreme scales.
  const MIN_DIM = 0.15;

  for (const part of manifest.parts) {
    const [px, py] = project(part.p);
    // Pick the in-plane bounds extents that match the projection. Bounds
    // are sizes (always >= 0) so we deliberately do NOT route them through
    // `project` — that helper negates one axis to fix the SVG-vs-Unity
    // y-down/y-up mismatch, which would flip our positive sizes negative.
    //   top-down (x, z): width = bx, height = bz
    //   side    (x, y): width = bx, height = by
    const w = Math.max(MIN_DIM, part.b[0]);
    const h =
      projection === "top"
        ? Math.max(MIN_DIM, part.b[2])
        : Math.max(MIN_DIM, part.b[1]);
    parts.push({ idx: part.i, cx: px, cy: py, w, h, area: w * h });
  }

  if (parts.length === 0) {
    return { parts, cx: 0, cy: 0, scale: 1 };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of parts) {
    minX = Math.min(minX, r.cx - r.w / 2);
    maxX = Math.max(maxX, r.cx + r.w / 2);
    minY = Math.min(minY, r.cy - r.h / 2);
    maxY = Math.max(maxY, r.cy + r.h / 2);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const widthM = Math.max(0.001, maxX - minX);
  const heightM = Math.max(0.001, maxY - minY);
  const innerW = SVG_VIEW_W - 2 * PANEL_PAD;
  const innerH = SVG_VIEW_H - 2 * PANEL_PAD;
  const scale = Math.min(innerW / widthM, innerH / heightM);

  return { parts, cx, cy, scale };
}

/**
 * Tag → fill colour. We deliberately keep the palette small and high-contrast
 * so a controller scanning a 2-inch tile can pick out cockpit / engines /
 * tanks at a glance. Falls back to a neutral grey when no tag matches.
 */
function pickFill(part: ManifestPart): string {
  const tags = new Set(part.tags);
  if (tags.has("cockpit")) return "rgb(252 211 77)"; // cockpit yellow
  if (tags.has("engine")) return "rgb(248 113 113)"; // engine red
  if (tags.has("oxidizer")) return "rgb(96 165 250)"; // oxidizer blue
  if (tags.has("fueltank")) return "rgb(74 222 128)"; // fuel green
  if (tags.has("parachute")) return "rgb(216 180 254)"; // parachute purple
  if (tags.has("decoupler")) return "rgb(251 146 60)"; // decoupler orange
  if (tags.has("wheel")) return "rgb(165 180 252)"; // wheel indigo
  if (tags.has("control-surface")) return "rgb(125 211 252)"; // surface cyan
  if (tags.has("science")) return "rgb(244 114 182)"; // science pink
  if (tags.has("launchclamp")) return "rgb(120 113 108)"; // clamp stone
  return "rgb(148 163 184)"; // structural slate
}

function pickStroke(part: ManifestPart): string {
  // Highlight crewed parts with a brighter stroke so they pop even when
  // overlapped by a larger structural fill.
  if (part.tags.includes("cockpit")) return "rgb(255 230 130)";
  return "rgb(15 23 42)";
}
