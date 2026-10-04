import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Optional raster viewer for the Kerbin Aeronautical Charts PDF (alexustas / ASET; CC BY-NC-SA 3.0).
 * Third-party documents and page images are excluded from the source repository.
 * Operators may install a licensed bundle locally using `web/public/charts/manifest.json`.
 *
 * Hotkeys: Left/Right or PageUp/PageDown step pages, Home/End jump to first/last, +/- zoom,
 * 0 fits, F toggles fullscreen.
 */

type ChartManifestPage = {
  page: number;
  file: string;
  thumb: string;
  widthPx: number;
  heightPx: number;
  title: string;
  blurb: string;
  chartTag: string | null;
};

type ChartManifest = {
  source: string;
  license: string;
  pageCount: number;
  renderZoom: number;
  pages: ChartManifestPage[];
};

const MANIFEST_URL = "/charts/manifest.json";
const ZOOM_STEPS = [0.25, 0.4, 0.6, 0.8, 1.0, 1.4, 2.0, 3.0];

function clampPage(n: number, pageCount: number): number {
  if (!Number.isFinite(n) || pageCount <= 0) return 1;
  if (n < 1) return 1;
  if (n > pageCount) return pageCount;
  return Math.floor(n);
}

function readInitialPage(pageCount: number): number {
  // URL hash takes priority over the per-tab session restore, so deep links
  // like `/charts#page=14` from the map (or the in-game button) always land
  // on the page the caller actually wanted.
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const m = /(?:^|[#&?])page=(\d+)/.exec(hash);
  if (m && m[1]) return clampPage(parseInt(m[1], 10), pageCount);
  try {
    const stored = sessionStorage.getItem("chartsPage");
    if (stored) return clampPage(parseInt(stored, 10), pageCount);
  } catch {
    /* sessionStorage may throw in privacy mode; ignore. */
  }
  return 1;
}

export function ChartsPage(): JSX.Element {
  const [manifest, setManifest] = useState<ChartManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState<number>(1);
  const [zoomMode, setZoomMode] = useState<"fit" | "actual" | number>("fit");
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`charts manifest HTTP ${r.status}`);
        return r.json() as Promise<ChartManifest>;
      })
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
        setPageNum(readInitialPage(data.pageCount));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pages = manifest?.pages ?? [];
  const currentPage: ChartManifestPage | null = pages[pageNum - 1] ?? null;

  const goTo = useCallback(
    (n: number) => {
      if (!manifest) return;
      const next = clampPage(n, manifest.pageCount);
      setPageNum(next);
      try {
        sessionStorage.setItem("chartsPage", String(next));
      } catch {
        /* ignore */
      }
      // Mirror the page into the URL hash without pushing a new history entry
      // — deep links like `/charts#page=14` survive a refresh / share.
      try {
        const newHash = `#page=${next}`;
        if (window.location.hash !== newHash) {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${newHash}`);
        }
      } catch {
        /* ignore */
      }
    },
    [manifest]
  );

  // React to hash changes (e.g. user pastes a different deep link in the URL bar
  // while the page is open).
  useEffect(() => {
    function onHash(): void {
      if (!manifest) return;
      const m = /(?:^|[#&?])page=(\d+)/.exec(window.location.hash);
      if (m && m[1]) setPageNum(clampPage(parseInt(m[1], 10), manifest.pageCount));
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [manifest]);

  // Keep the active thumbnail visible in the strip when paging via the keyboard.
  useEffect(() => {
    if (!stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(`[data-page="${pageNum}"]`);
    if (el) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [pageNum]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!manifest) return;
      // Don't hijack typing inside text fields (in case we ever add a search box).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          goTo(pageNum + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          goTo(pageNum - 1);
          break;
        case "Home":
          e.preventDefault();
          goTo(1);
          break;
        case "End":
          e.preventDefault();
          goTo(manifest.pageCount);
          break;
        case "+":
        case "=":
          e.preventDefault();
          setZoomMode((z) => stepZoom(z, +1));
          break;
        case "-":
        case "_":
          e.preventDefault();
          setZoomMode((z) => stepZoom(z, -1));
          break;
        case "0":
          e.preventDefault();
          setZoomMode("fit");
          break;
        case "1":
          e.preventDefault();
          setZoomMode("actual");
          break;
        case "f":
        case "F":
          e.preventDefault();
          setFullscreen((v) => !v);
          break;
        default:
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [manifest, pageNum, goTo]);

  const viewerStyle: React.CSSProperties = useMemo(() => {
    if (zoomMode === "fit") return { width: "100%", height: "auto", maxHeight: "78vh", objectFit: "contain" };
    if (zoomMode === "actual") return { width: currentPage ? `${currentPage.widthPx}px` : "auto", height: "auto" };
    return {
      width: currentPage ? `${Math.round(currentPage.widthPx * zoomMode)}px` : "auto",
      height: "auto",
    };
  }, [zoomMode, currentPage]);

  if (error) {
    return (
      <div className="card">
        <h2>Charts</h2>
        <p style={{ color: "#fca5a5" }}>Failed to load chart manifest: {error}</p>
        <p>
          Install an optional licensed chart bundle and its manifest under <code>web/public/charts/</code>.
        </p>
      </div>
    );
  }

  if (manifest && manifest.pages.length === 0) {
    return (
      <div className="card">
        <h2>Charts</h2>
        <p>No chart bundle is installed. Charts are optional and supplied separately under their author's license.</p>
      </div>
    );
  }

  if (!manifest || !currentPage) {
    return (
      <div className="card">
        <h2>Charts</h2>
        <p>Loading charts…</p>
      </div>
    );
  }

  const containerClass = "charts-page" + (fullscreen ? " charts-page-fullscreen" : "");

  return (
    <div className={containerClass}>
      <div className="card charts-header">
        <div className="card-head">
          <h2>Kerbin Aeronautical Charts</h2>
          <div className="charts-toolbar" role="toolbar" aria-label="Chart controls">
            <button type="button" onClick={() => goTo(pageNum - 1)} disabled={pageNum <= 1} aria-label="Previous page">
              ‹
            </button>
            <span className="charts-page-readout" aria-live="polite">
              Page <strong>{pageNum}</strong> / {manifest.pageCount}
              {currentPage.chartTag ? <code style={{ marginLeft: "0.4rem" }}>{currentPage.chartTag}</code> : null}
            </span>
            <button
              type="button"
              onClick={() => goTo(pageNum + 1)}
              disabled={pageNum >= manifest.pageCount}
              aria-label="Next page"
            >
              ›
            </button>
            <span className="charts-toolbar-sep" aria-hidden>
              |
            </span>
            <button type="button" onClick={() => setZoomMode((z) => stepZoom(z, -1))} aria-label="Zoom out">
              −
            </button>
            <button type="button" onClick={() => setZoomMode("fit")} title="Fit to width (0)">
              Fit
            </button>
            <button type="button" onClick={() => setZoomMode("actual")} title="Actual pixels (1)">
              1:1
            </button>
            <button type="button" onClick={() => setZoomMode((z) => stepZoom(z, +1))} aria-label="Zoom in">
              +
            </button>
            <span className="charts-toolbar-sep" aria-hidden>
              |
            </span>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title="Toggle fullscreen (F)"
              aria-pressed={fullscreen}
            >
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <a
              href={currentPage.file}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this page in a new tab"
            >
              Open
            </a>
          </div>
        </div>
        <p className="charts-blurb">
          <strong>{currentPage.title}</strong>
          {currentPage.blurb ? <span> — {currentPage.blurb}</span> : null}
        </p>
      </div>

      <div className="charts-body">
        <nav className="charts-strip" aria-label="Chart pages" ref={stripRef}>
          {pages.map((p) => (
            <button
              key={p.page}
              type="button"
              data-page={p.page}
              className={"charts-strip-item" + (p.page === pageNum ? " charts-strip-item-active" : "")}
              onClick={() => goTo(p.page)}
              title={`${p.title}${p.chartTag ? ` (${p.chartTag})` : ""}`}
            >
              <img src={p.thumb} alt="" loading="lazy" width={120} />
              <span className="charts-strip-label">
                <span className="charts-strip-num">{p.page}</span>
                <span className="charts-strip-title">{p.title}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="charts-viewer card" aria-label={`Chart page ${currentPage.page}: ${currentPage.title}`}>
          <img
            key={currentPage.file}
            src={currentPage.file}
            alt={`Page ${currentPage.page}: ${currentPage.title}`}
            style={viewerStyle}
            draggable={false}
          />
        </div>
      </div>

      <div className="card charts-footer">
        <p>
          Source: <code>{manifest.source}</code>. Licensed{" "}
          <a
            href="https://creativecommons.org/licenses/by-nc-sa/3.0/"
            target="_blank"
            rel="noopener noreferrer"
          >
            CC BY-NC-SA 3.0
          </a>{" "}
          by alexustas / ASET Aviation Agency. Raster pages are produced locally by{" "}
          <code>web/public/maps/_aero_preview/render_charts.py</code> (they are not committed by
          default). Tabular navaid / aerodrome fields for the live map live in{" "}
          <code>web/src/data/kerbinAeroCharts.ts</code>.
        </p>
        <p className="charts-shortcuts">
          Shortcuts: ← / → page • Home / End jump • + / − zoom • 0 fit • 1 actual • F fullscreen.
        </p>
      </div>
    </div>
  );
}

function stepZoom(current: "fit" | "actual" | number, dir: 1 | -1): "fit" | "actual" | number {
  const idx = currentZoomIndex(current);
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir));
  return ZOOM_STEPS[next] ?? 1.0;
}

function currentZoomIndex(current: "fit" | "actual" | number): number {
  if (current === "fit") return 3; // 0.8x — slightly less than the canonical "fit" so + grows from a sensible base.
  if (current === "actual") return ZOOM_STEPS.indexOf(1.0);
  // Snap to the nearest step.
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const step = ZOOM_STEPS[i];
    if (step === undefined) continue;
    const d = Math.abs(step - current);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
