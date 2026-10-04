import { JSX, useMemo } from "react";
import type { SystemCatalog, SystemCatalogBody } from "../data/systemCatalog";

/**
 * Body picker. Lists every body in the catalog, hierarchically (star → planets → moons), with a
 * vessel-count badge per row. Clicking a row asks the parent component to focus that body.
 *
 * The picker is only rendered when a catalog is available (controllers on unsupported planet packs
 * never see it — see `useSystemCatalog`). It does NOT itself filter or sort vessels; that's the
 * parent's job.
 */

type Props = {
  catalog: SystemCatalog;
  /** Current focus. The matching row is highlighted. */
  focusedBodyName: string;
  /** Vessel counts keyed by body name (case-insensitive lookup happens internally). */
  vesselCounts: Map<string, number>;
  onFocus: (bodyName: string) => void;
  /** Optional: hide stars from the list (you can't really "focus" the sun on a 2D map). */
  hideStars?: boolean;
};

type Row = {
  body: SystemCatalogBody;
  /** 0 = star, 1 = planet, 2 = moon, 3+ = sub-moon (rare). */
  depth: number;
};

function buildRows(catalog: SystemCatalog): Row[] {
  const byParent = new Map<string | null, SystemCatalogBody[]>();
  for (const b of catalog.bodies) {
    const k = b.parent;
    const arr = byParent.get(k) ?? [];
    arr.push(b);
    byParent.set(k, arr);
  }

  const rows: Row[] = [];
  function walk(parent: string | null, depth: number): void {
    const kids = byParent.get(parent) ?? [];
    // Sort siblings by SMA so the picker reads outward from the parent — same order most KSP
    // players have memorized from the map view.
    kids.sort((a, b) => (a.semiMajorAxisM ?? 0) - (b.semiMajorAxisM ?? 0));
    for (const k of kids) {
      rows.push({ body: k, depth });
      walk(k.name, depth + 1);
    }
  }
  walk(null, 0);
  return rows;
}

function vesselCountFor(counts: Map<string, number>, bodyName: string): number {
  const lower = bodyName.toLowerCase();
  for (const [k, v] of counts) {
    if (k.toLowerCase() === lower) return v;
  }
  return 0;
}

export function BodyPicker({ catalog, focusedBodyName, vesselCounts, onFocus, hideStars = false }: Props): JSX.Element {
  const rows = useMemo(() => buildRows(catalog), [catalog]);
  const focusedLower = focusedBodyName.toLowerCase();

  return (
    <div className="body-picker" role="navigation" aria-label="Solar system bodies">
      <div className="body-picker-header">
        <span className="body-picker-title">{catalog.displayName}</span>
        <span className="body-picker-count">{rows.length} bodies</span>
      </div>
      <ul className="body-picker-list">
        {rows.map(({ body, depth }) => {
          if (hideStars && body.isStar) return null;
          const isFocused = body.name.toLowerCase() === focusedLower;
          const count = vesselCountFor(vesselCounts, body.name);
          return (
            <li
              key={body.name}
              className={`body-picker-row${isFocused ? " body-picker-row-focused" : ""}${body.isStar ? " body-picker-row-star" : ""}`}
              style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
            >
              <button
                type="button"
                className="body-picker-button"
                onClick={() => onFocus(body.name)}
                aria-pressed={isFocused}
                disabled={body.isStar}
                title={body.isStar ? `${body.displayName} (central star — no surface map)` : `Focus ${body.displayName}`}
              >
                <span className="body-picker-name">{body.displayName}</span>
                {count > 0 ? (
                  <span className="body-picker-badge" aria-label={`${count} vessel${count === 1 ? "" : "s"}`}>
                    {count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
