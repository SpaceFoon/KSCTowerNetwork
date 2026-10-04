import { JSX, useMemo } from "react";
import type { SystemCatalog } from "../data/systemCatalog";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";

/**
 * "Off-World Traffic" sidebar. The legacy TowerDesk map filters vessels to the home body and
 * silently drops everyone else; this panel surfaces those drops, grouped by which body they're
 * on, so a controller can at least *see* that a Mun lander or Duna probe exists.
 *
 * Each row shows whatever the existing telemetry frame already has — `bodyName`, `situation`,
 * radar/ASL altitude, biome — and a click jumps the BodyMap focus to that body. Nothing is
 * fetched here; the parent passes the already-resolved vessel list.
 */

export type OffWorldVessel = {
  id: string;
  callsign: string;
  /** KSP body name from telemetry. May or may not be in the catalog (for unknown bodies). */
  bodyName: string;
  situation?: string;
  radarAltM?: number;
  aslAltM?: number;
  /** Apoapsis (m) — present for orbiting / sub-orbital telemetry. */
  apoapsisM?: number;
  periapsisM?: number;
  biome?: string;
  /** True if this is the viewer's own ship. */
  isSelf?: boolean;
};

type Props = {
  /** All vessels NOT on the currently focused body. */
  vessels: OffWorldVessel[];
  /** Optional — used to render display names + parent context (e.g. "Mun (orbits Kerbin)"). */
  catalog: SystemCatalog | null;
  onFocusBody: (bodyName: string) => void;
  /** Bodies known to be in the catalog but with no vessels are filtered out — this list reflects
   *  reality, not the catalog menu. */
};

function fmtAlt(m: number | undefined): string {
  if (m === undefined || !Number.isFinite(m)) return "—";
  if (Math.abs(m) >= 1_000_000) return `${(m / 1_000_000).toFixed(2)} Mm`;
  if (Math.abs(m) >= 1_000) return `${(m / 1_000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}

function bodyDisplay(catalog: SystemCatalog | null, bodyName: string): { display: string; parent: string | null } {
  if (!catalog) return { display: bodyName, parent: null };
  const lower = bodyName.toLowerCase();
  const hit = catalog.bodies.find((b) => b.name.toLowerCase() === lower);
  if (!hit) return { display: bodyName, parent: null };
  return { display: hit.displayName, parent: hit.parent };
}

export function OffWorldTrafficPanel({ vessels, catalog, onFocusBody }: Props): JSX.Element {
  const groups = useMemo(() => {
    const m = new Map<string, OffWorldVessel[]>();
    for (const v of vessels) {
      const key = v.bodyName || "(unknown)";
      const arr = m.get(key) ?? [];
      arr.push(v);
      m.set(key, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [vessels]);

  if (vessels.length === 0) {
    return (
      <aside className="off-world-panel" aria-label="Off-world traffic">
        <div className="off-world-panel-header">
          <strong>Off-world traffic</strong>
          <span className="off-world-panel-count">none</span>
        </div>
        <p className="off-world-panel-empty">All known vessels are on the focused body.</p>
      </aside>
    );
  }

  return (
    <aside className="off-world-panel" aria-label="Off-world traffic">
      <div className="off-world-panel-header">
        <strong>Off-world traffic</strong>
        <span className="off-world-panel-count">{vessels.length}</span>
      </div>
      <ul className="off-world-panel-groups">
        {groups.map(([bodyName, list]) => {
          const { display, parent } = bodyDisplay(catalog, bodyName);
          return (
            <li key={bodyName} className="off-world-panel-group">
              <button
                type="button"
                className="off-world-panel-body-button"
                onClick={() => onFocusBody(bodyName)}
                title={`Focus ${display} on the body map`}
              >
                <span className="off-world-panel-body-name">{display}</span>
                {parent ? <span className="off-world-panel-body-parent">orbits {parent}</span> : null}
                <span className="off-world-panel-body-count">{list.length}</span>
              </button>
              <ul className="off-world-panel-vessels">
                {list.map((v) => (
                  <li
                    key={v.id}
                    className={`off-world-panel-vessel${v.isSelf ? " off-world-panel-vessel-self" : ""}`}
                  >
                    <span className="off-world-panel-vessel-call" title={CALLSIGN_DISPLAY_HELP}>
                      {v.callsign}
                    </span>
                    <span className="off-world-panel-vessel-meta">
                      {v.situation ?? "—"}
                      {v.situation === "ORBITING" || v.situation === "SUB_ORBITAL" || v.situation === "ESCAPING"
                        ? ` • Ap ${fmtAlt(v.apoapsisM)} / Pe ${fmtAlt(v.periapsisM)}`
                        : v.radarAltM !== undefined
                          ? ` • RA ${fmtAlt(v.radarAltM)}`
                          : v.aslAltM !== undefined
                            ? ` • ALT ${fmtAlt(v.aslAltM)}`
                            : ""}
                      {v.biome ? ` • ${v.biome}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
