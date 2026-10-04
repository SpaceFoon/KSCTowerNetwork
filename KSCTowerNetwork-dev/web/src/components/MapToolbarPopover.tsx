import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reusable pill-trigger + popover for the floating map toolbar (Navaids / Sites /
 * Map-type dropdowns). The visual style mirrors `MapBodyDropdown`'s "Map: …" pill
 * and tab-strip popover so the three new groups read as siblings of the existing
 * world picker — same border/backdrop/typography, same caret, same right-anchored
 * popover that won't get clipped by the toolbar's `overflow-x: clip`.
 *
 * The popover dismisses on outside click and Escape. Nothing inside is render-cost
 * sensitive (a handful of checkboxes), so we don't bother lazy-mounting children.
 *
 * Why a separate component instead of inlining each <details>? We need:
 *   - shared dismiss-on-outside-click semantics across three independent popovers
 *   - explicit z-index above the floating toolbar (z-index 5) — `<details>` doesn't
 *     give us that without extra CSS plumbing
 *   - aria-haspopup="dialog" + aria-expanded on the trigger for screen readers
 */

type Props = {
  /** Short uppercase label rendered as the pill's primary text (e.g. "Navaids"). */
  label: string;
  /** Optional secondary string showing the active selection (e.g. "Alt"). Shown muted, after the label. */
  summary?: string;
  /** Tooltip on the pill trigger. */
  title?: string;
  /** True when at least one option in the popover is non-default — adds the accent border. */
  active?: boolean;
  /** Anchor edge for the popover. Defaults to "right" so popovers open leftward and stay inside the toolbar's clip. */
  anchor?: "left" | "right";
  /** Popover content. */
  children: ReactNode;
};

export function MapToolbarPopover({
  label,
  summary,
  title,
  active,
  anchor = "right",
  children
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      if (e.target instanceof Node && wrap.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tower-map-popover-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`tower-map-world-pill${active ? " tower-map-world-pill-override" : ""}`}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <strong>{label}</strong>
        {summary ? (
          <span className="tower-map-world-trigger-label">{summary}</span>
        ) : null}
        <span className="tower-map-world-caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div
          className={`tower-map-toolbar-popover tower-map-toolbar-popover-${anchor}`}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
