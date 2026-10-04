import { JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BodyPicker } from "./BodyPicker";
import { loadSystemCatalog, type SystemCatalog } from "../data/systemCatalog";

/**
 * Map-body dropdown. Replaces the old plain `<select>` for picking which body's basemap to show.
 *
 * Renders a pill-shaped trigger button summarizing the current state ("Map: Auto · Kerbin", or
 * "Map: Mun" for an override). Clicking opens a popover with:
 *   - An "Auto" row that follows the live KSP home body.
 *   - A tab strip listing every static system catalog we want to expose (the live world's catalog
 *     plus RSS, de-duplicated). Each tab embeds a full `BodyPicker` so the operator sees the
 *     hierarchy (star → planets → moons) instead of a flat alphabetical select.
 *
 * Clicking a body in the picker sets BOTH the basemap-body override and the focused body so the
 * map view jumps straight to it. The popover closes on outside click / Escape.
 *
 * Cross-catalog focus: if the user picks an RSS body while the live world is OPM, the basemap URL
 * is constructed against the OPM worldId (since the rest of the surface UI is built around the
 * live catalog) and may 404. That's a deliberately small first step — the user asked specifically
 * for the picker UI to live here; broader cross-pack basemap support is out of scope.
 */

type Props = {
  /** Live world id reported by the plugin (e.g. `"kerbin-opm"`). Null if no inventory yet. */
  liveWorldId: string | null | undefined;
  /** Live home body name (e.g. `"Kerbin"`). Used for the Auto-row label. */
  liveHomeName: string;
  /** Live home body display name (e.g. `"Kerbin"`). May equal `liveHomeName`. */
  liveHomeDisplay: string;
  /** Whether `worldInventory` ever published. Drives the "(default)" suffix on Auto. */
  hasLiveInventory: boolean;
  /** Map-relevant mod count for the trailing badge. 0 = no badge. */
  modCount: number;
  /**
   * Identifier of the pilot the controller is currently watching (e.g. `"Jeb"` from telemetry,
   * or a pilot user-id from the active-pilots list). Surfaces in the Auto row so the controller
   * sees "Auto · follow Jeb on Mun" instead of a generic "Kerbin (default)" — the whole point of
   * the Auto branch is "follow whichever pilot I just clicked".
   */
  selectedPilotLabel?: string | null;
  /**
   * Body the selected pilot's vessel is *currently* on, per live telemetry. Preferred over
   * `liveHomeName` for the Auto label since a pilot might be on Mun even though the planet pack's
   * home body is Kerbin.
   */
  currentBodyName?: string | null;
  /** Display variant of `currentBodyName` when telemetry provides one. Falls back to the raw name. */
  currentBodyDisplay?: string | null;
  /** Current `mapBodyPref` value: "auto" or a body name. */
  mapBodyPref: string;
  setMapBodyPref: (v: string) => void;
  /**
   * Currently focused body for the BodyPicker highlight. Optional — the wall slot variant of the
   * tower map doesn't track a focus, so it just falls through to `mapBodyPref` for the highlight.
   */
  focusedBodyName?: string | null;
  /**
   * Optional. When provided, picking a body in the popover ALSO updates the focused body so the
   * surrounding desk can swap the map view. When omitted, picking a body only updates the basemap
   * preference (the wall-slot KerbinTowerMap path takes this branch).
   */
  setFocusedBodyName?: (v: string | null) => void;
  /** Vessel counts for badge rendering inside the picker (case-insensitive). */
  vesselCounts?: Map<string, number>;
};

/**
 * The catalog ids we always want to surface as tabs, regardless of whether the plugin has
 * published a `worldInventory` yet. Every bundled `web/public/system-catalogs/*.json` should be
 * listed here so the operator can browse Stock Kerbol, OPM, JNSQ, and RSS bodies even before
 * (or without) any live KSP session. The live world's id is still pushed to the FRONT of the
 * list when known, so the operator's primary catalog is the leftmost tab and the default active
 * tab on first open.
 *
 * Order is "smallest superset first": Stock → OPM (stock + outer planets) → JNSQ (rescaled
 * stock-like) → RSS (real solar system). When no live world is known, `kerbin-stock` is the
 * leftmost tab so the dropdown opens on the system every KSP install ships with.
 */
const ALWAYS_OFFERED_CATALOG_IDS: readonly string[] = [
  "kerbin-stock",
  "kerbin-opm",
  "kerbin-jnsq",
  "earth-rss"
];

export function MapBodyDropdown({
  liveWorldId,
  liveHomeName: _liveHomeName,
  liveHomeDisplay,
  hasLiveInventory,
  modCount,
  selectedPilotLabel,
  currentBodyName,
  currentBodyDisplay,
  mapBodyPref,
  setMapBodyPref,
  focusedBodyName,
  setFocusedBodyName,
  vesselCounts
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [catalogs, setCatalogs] = useState<readonly SystemCatalog[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // The list of catalog ids to load: live world + ALWAYS_OFFERED_CATALOG_IDS, de-duplicated, with
  // live world first so it becomes the default active tab.
  const catalogIds = useMemo<readonly string[]>(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const live = (liveWorldId ?? "").trim();
    if (live && !live.startsWith("unknown-")) {
      ids.push(live);
      seen.add(live);
    }
    for (const id of ALWAYS_OFFERED_CATALOG_IDS) {
      if (seen.has(id)) continue;
      ids.push(id);
      seen.add(id);
    }
    return ids;
  }, [liveWorldId]);

  // Lazy-load catalogs on first open. The `loadSystemCatalog` cache means re-opens are free.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all(catalogIds.map((id) => loadSystemCatalog(id).then((c) => ({ id, c }))))
      .then((rows) => {
        if (cancelled) return;
        const ready = rows
          .map(({ c }) => c)
          .filter((c): c is SystemCatalog => c != null);
        setCatalogs(ready);
        setActiveTabId((prev) => {
          if (prev && ready.some((c) => c.worldId === prev)) return prev;
          return ready[0]?.worldId ?? null;
        });
      })
      .catch(() => {
        // Silent — popover just shows "no catalogs available".
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalogIds]);

  // Close on outside click + Escape. Mounted only while `open` to avoid touching listeners
  // during normal tower-desk render churn.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      if (e.target instanceof Node && wrap.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The Auto branch follows whatever pilot the controller has selected. We prefer the live
  // telemetry body (e.g. "Mun") because it's the freshest signal — it changes the moment the
  // pilot enters a new SoI, well before the next world-inventory POST. We fall back to the
  // planet-pack home body (worldInventory.home), and only land on the static "Kerbin (default)"
  // string when literally nothing has been published for the picked session yet.
  const knownBody =
    (currentBodyDisplay && currentBodyDisplay.trim()) ||
    (currentBodyName && currentBodyName.trim()) ||
    null;
  const knownHome = hasLiveInventory ? liveHomeDisplay : null;
  const autoBodyLabel = knownBody ?? knownHome ?? `${liveHomeDisplay} (default)`;
  const pilot = (selectedPilotLabel ?? "").trim();
  const autoSummary = pilot ? `${pilot} · ${autoBodyLabel}` : autoBodyLabel;
  const autoHint = pilot
    ? `follow ${pilot} on ${autoBodyLabel}`
    : `follow live KSP body · ${autoBodyLabel}`;

  const isOverride = mapBodyPref !== "auto";
  const triggerLabel = isOverride ? mapBodyPref : `Auto · ${autoSummary}`;
  const triggerTitle = isOverride
    ? `Manual basemap override — showing ${mapBodyPref}. ${pilot ? `Selected pilot: ${pilot}. ` : ""}Live body: ${autoBodyLabel}. Click to change or pick Auto.`
    : hasLiveInventory || knownBody
      ? `Auto-following the selected pilot${pilot ? ` (${pilot})` : ""} on ${autoBodyLabel}. ${modCount} map-relevant mod(s) detected.`
      : "Auto-following the selected pilot. No world inventory or telemetry published yet — using stock-Kerbin defaults.";

  const activeCatalog = useMemo(
    () => catalogs.find((c) => c.worldId === activeTabId) ?? null,
    [catalogs, activeTabId]
  );

  const onPickBody = useCallback(
    (bodyName: string) => {
      setMapBodyPref(bodyName);
      setFocusedBodyName?.(bodyName);
      setOpen(false);
    },
    [setMapBodyPref, setFocusedBodyName]
  );

  const onPickAuto = useCallback(() => {
    setMapBodyPref("auto");
    setFocusedBodyName?.(null);
    setOpen(false);
  }, [setMapBodyPref, setFocusedBodyName]);

  const highlightBody = focusedBodyName ?? (mapBodyPref === "auto" ? "" : mapBodyPref);
  const emptyCounts = useMemo(() => new Map<string, number>(), []);

  return (
    <div className="tower-map-world-dropdown" ref={wrapRef}>
      <button
        type="button"
        className={`tower-map-world-pill${isOverride ? " tower-map-world-pill-override" : ""}`}
        title={triggerTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <strong>Map:</strong> <span className="tower-map-world-trigger-label">{triggerLabel}</span>
        {modCount > 0 ? (
          <span className="tower-map-world-pill-mods">
            {" · "}
            {modCount} mod{modCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <span className="tower-map-world-caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div className="tower-map-world-popover" role="dialog" aria-label="Pick basemap body">
          <button type="button" className="tower-map-world-auto-row" onClick={onPickAuto} aria-pressed={!isOverride}>
            <span className="tower-map-world-auto-label">Auto · {autoSummary}</span>
            <span className="tower-map-world-auto-hint">{autoHint}</span>
          </button>

          {catalogs.length > 1 ? (
            <div className="tower-map-world-tabs" role="tablist">
              {catalogs.map((c) => {
                const selected = c.worldId === activeTabId;
                return (
                  <button
                    key={c.worldId}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`tower-map-world-tab${selected ? " tower-map-world-tab-active" : ""}`}
                    onClick={() => setActiveTabId(c.worldId)}
                    title={c.displayName}
                  >
                    {tabShortLabel(c)}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="tower-map-world-tabpanel" role="tabpanel">
            {activeCatalog ? (
              <BodyPicker
                catalog={activeCatalog}
                focusedBodyName={highlightBody}
                vesselCounts={vesselCounts ?? emptyCounts}
                onFocus={onPickBody}
                hideStars
              />
            ) : (
              <p className="tower-map-world-empty">
                No system catalogs available. The plugin has not yet identified the active planet pack.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact tab label. We trim the verbose `displayName` ("Stock Kerbol + Outer Planets Mod" /
 * "Real Solar System") down to one or two words so four tabs fit on one row inside the popover
 * without wrapping. The full `displayName` is still surfaced via the tab `title` tooltip.
 */
function tabShortLabel(c: SystemCatalog): string {
  const id = c.worldId.toLowerCase();
  if (id === "earth-rss") return "RSS";
  if (id === "kerbin-opm") return "OPM";
  if (id === "kerbin-jnsq") return "JNSQ";
  if (id === "kerbin-stock") return "Stock";
  return c.displayName;
}
