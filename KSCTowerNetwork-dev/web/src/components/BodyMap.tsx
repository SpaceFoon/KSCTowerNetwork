import { JSX } from "react";

/**
 * Per-body 2D map for "off-home" celestial bodies (Mun, Duna, Laythe, Earth's Moon, etc.).
 *
 * The big legacy map in `TowerDesk.tsx` keeps owning the *home* body view because it has years
 * of tower-specific overlays (chart key, hypsometric legend, navaid hover details, click
 * handlers). This component is the simpler complement: when the controller focuses any non-home
 * body in the system, we render a fresh equirectangular plate here with vessels/navaids/launch
 * sites projected onto it. Same viewBox (596x298) so the coordinate math stays identical.
 *
 * If the bundled basemap for `(worldId, bodyName)` is missing or fails to load (real bake hasn't
 * been generated yet for that pack/body), we render a flat-color stub disc plus a graticule so
 * vessel dots still place correctly.
 */

const VB_W = 596;
const VB_H = 298;
const PRESERVE_ASPECT = "xMidYMid meet";
const MERIDIANS = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150] as const;
const PARALLELS = [-60, -30, 0, 30, 60] as const;

function normalizeLon(lon: number): number {
  let v = lon;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function latLonToXY(lat: number, lon: number): { x: number; y: number } {
  const u = (normalizeLon(lon) + 180) / 360;
  const v = (90 - lat) / 180;
  return { x: u * VB_W, y: v * VB_H };
}

export type BodyMapVessel = {
  /** Stable id (session id is fine). Used for React keys and click handlers. */
  id: string;
  /** Pilot or craft display name; rendered as a subscript label. */
  label: string;
  lat: number;
  lon: number;
  /** Optional KSP situation string ("LANDED", "ORBITING", ...). Drives the dot color. */
  situation?: string;
  /** True if this is the viewer's own vessel (highlighted). */
  isSelf?: boolean;
};

export type BodyMapNavaid = {
  id: string;
  name: string;
  kind: "VOR" | "ILS" | "NDB";
  lat: number;
  lon: number;
};

export type BodyMapLaunchSite = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

type Props = {
  bodyName: string;
  bodyDisplayName?: string;
  /** The body's parent in the catalog (e.g. "Kerbol", "Jool"). Shown in the corner. */
  parentBodyName?: string | null;
  /** Same-origin URL of the pre-baked SVG plate. Falls back to a stub disc on load error. */
  basemapUrl: string;
  vessels: BodyMapVessel[];
  navaids: BodyMapNavaid[];
  launchSites: BodyMapLaunchSite[];
  /** Body color used for the stub disc fill when the basemap fails to load. */
  stubFill?: string;
  /** Stretch the map and basemap to fill a Tower Wall slot. */
  wallSlot?: boolean;
  /** Click on a vessel dot. */
  onVesselClick?: (id: string) => void;
};

/**
 * Color the dot to communicate KSP `Vessel.Situations` at a glance. Falls back to a neutral tone
 * when the situation string is missing or unrecognized — tower controllers are used to color
 * coding, blank dots are still useful as "vessel here".
 */
function dotColorForSituation(situation: string | undefined): string {
  switch ((situation ?? "").toUpperCase()) {
    case "LANDED":
      return "#a16207";
    case "SPLASHED":
      return "#0e7490";
    case "PRELAUNCH":
      return "#84cc16";
    case "FLYING":
      return "#22c55e";
    case "SUB_ORBITAL":
      return "#f59e0b";
    case "ORBITING":
      return "#3b82f6";
    case "ESCAPING":
      return "#a855f7";
    case "DOCKED":
      return "#6366f1";
    default:
      return "#94a3b8";
  }
}

export function BodyMap({
  bodyName,
  bodyDisplayName,
  parentBodyName,
  basemapUrl,
  vessels,
  navaids,
  launchSites,
  stubFill = "#1f2937",
  wallSlot = false,
  onVesselClick
}: Props): JSX.Element {
  const display = bodyDisplayName || bodyName;

  return (
    <div className={`body-map${wallSlot ? " body-map--wall-fill" : ""}`}>
      <div className="body-map-header">
        <div className="body-map-title">
          <strong>{display}</strong>
          {parentBodyName ? <span className="body-map-parent"> orbiting {parentBodyName}</span> : null}
        </div>
        <div className="body-map-vessel-count">
          {vessels.length === 0
            ? "No vessels on this body"
            : vessels.length === 1
              ? "1 vessel"
              : `${vessels.length} vessels`}
        </div>
      </div>

      <svg
        className={`body-map-svg${wallSlot ? " body-map-svg--wall-fill" : ""}`}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio={wallSlot ? "none" : PRESERVE_ASPECT}
        role="img"
        aria-label={`Equirectangular map of ${display}`}
      >
        <BodyMapBackground
          basemapUrl={basemapUrl}
          stubFill={stubFill}
          bodyName={bodyName}
          wallSlot={wallSlot}
        />

        <g className="body-map-graticule" stroke="rgba(148, 163, 184, 0.35)" strokeWidth={0.4} fill="none">
          {MERIDIANS.map((lon) => {
            const x = latLonToXY(0, lon).x;
            return <line key={`m-${lon}`} x1={x} y1={0} x2={x} y2={VB_H} />;
          })}
          {PARALLELS.map((lat) => {
            const y = latLonToXY(lat, 0).y;
            return <line key={`p-${lat}`} x1={0} y1={y} x2={VB_W} y2={y} />;
          })}
          <line x1={0} y1={VB_H / 2} x2={VB_W} y2={VB_H / 2} stroke="rgba(148, 163, 184, 0.55)" strokeWidth={0.6} />
        </g>

        <g className="body-map-launch-sites">
          {launchSites.map((s) => {
            const { x, y } = latLonToXY(s.lat, s.lon);
            return (
              <g key={s.id} transform={`translate(${x} ${y})`}>
                <rect x={-3} y={-3} width={6} height={6} fill="#fbbf24" stroke="#78350f" strokeWidth={0.5} />
                <text x={5} y={3} fontSize={6} fill="#fbbf24" stroke="#0f172a" strokeWidth={0.3} paintOrder="stroke">
                  {s.name}
                </text>
              </g>
            );
          })}
        </g>

        <g className="body-map-navaids">
          {navaids.map((n) => {
            const { x, y } = latLonToXY(n.lat, n.lon);
            return (
              <g key={n.id} transform={`translate(${x} ${y})`}>
                <circle r={2.2} fill="none" stroke="#22d3ee" strokeWidth={0.6} />
                <circle r={0.6} fill="#22d3ee" />
                <text x={3.2} y={1.6} fontSize={5} fill="#22d3ee" stroke="#0f172a" strokeWidth={0.25} paintOrder="stroke">
                  {n.name} {n.kind}
                </text>
              </g>
            );
          })}
        </g>

        <g className="body-map-vessels">
          {vessels.map((v) => {
            const { x, y } = latLonToXY(v.lat, v.lon);
            const fill = dotColorForSituation(v.situation);
            return (
              <g
                key={v.id}
                transform={`translate(${x} ${y})`}
                style={onVesselClick ? { cursor: "pointer" } : undefined}
                onClick={onVesselClick ? () => onVesselClick(v.id) : undefined}
              >
                <circle r={v.isSelf ? 5.5 : 3} fill={fill} stroke={v.isSelf ? "#fde68a" : "#0f172a"} strokeWidth={v.isSelf ? 1.45 : 0.6} />
                <text x={v.isSelf ? 7 : 5} y={2} fontSize={5.5} fill="#e5e7eb" stroke="#0f172a" strokeWidth={0.3} paintOrder="stroke">
                  {v.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/**
 * Renders the basemap as an `<image>` element. SVG `<image>` silently shows nothing on a 404,
 * so we ALSO paint a fallback rect underneath in the body's stub color — that way the layer is
 * never blank, even if the bake isn't there yet.
 */
function BodyMapBackground({
  basemapUrl,
  stubFill,
  bodyName,
  wallSlot
}: {
  basemapUrl: string;
  stubFill: string;
  bodyName: string;
  wallSlot: boolean;
}): JSX.Element {
  return (
    <g>
      <rect x={0} y={0} width={VB_W} height={VB_H} fill={stubFill} />
      <image
        href={basemapUrl}
        x={0}
        y={0}
        width={VB_W}
        height={VB_H}
        preserveAspectRatio={wallSlot ? "none" : PRESERVE_ASPECT}
        aria-label={`${bodyName} basemap`}
      />
    </g>
  );
}
