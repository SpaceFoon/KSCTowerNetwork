import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterAerochartPages, type AerochartPage, type AerochartManifest } from "../data/aerochartIndex";
import "./ChartsPage.css";

/**
 * Complete Kerbin Aeronautical Charts reference (alexustas / ASET; CC BY-NC-SA 3.0).
 * Original pages accompany the searchable transcript so diagrams and custom-font
 * symbols remain available even when PDF text extraction is incomplete.
 *
 * Hotkeys: Left/Right or PageUp/PageDown step pages, Home/End jump to first/last, +/- zoom,
 * 0 fits, F toggles fullscreen.
 */

const CHART_SOURCE_URL = "https://github.com/StoneBlue/ASET-Consolidated-Avionics/blob/main/Docs%20%26%20Manuals/ASET%20Consolidated%20Avionics-%20Kerbin%20AEROCHARTS%20v17-11-25.pdf";

function ChartInstallHelp(): JSX.Element {
  return <>
    <p>Charts are optional. Ask the server owner to install the Kerbin Aeronautical Charts.</p>
    <p><a href={CHART_SOURCE_URL} target="_blank" rel="noopener noreferrer">Download the original PDF from the ASET repository</a></p>
    <p>Server owners: follow <a href="/charts/README.md" target="_blank" rel="noopener noreferrer">the chart installation instructions</a>, then reload this page.</p>
    <p>Charts by alexustas / ASET Aviation Agency, under <a href="https://creativecommons.org/licenses/by-nc-sa/3.0/" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 3.0</a>.</p>
  </>;
}

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
  const [manifest, setManifest] = useState<AerochartManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState<number>(1);
  const [zoomMode, setZoomMode] = useState<"fit" | "actual" | number>("fit");
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [imageError, setImageError] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`charts manifest HTTP ${r.status}`);
        return r.json() as Promise<AerochartManifest>;
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
  const currentPage: AerochartPage | null = pages[pageNum - 1] ?? null;
  const visiblePages = filterAerochartPages(pages, query, category);
  const categories = [...new Set(pages.map((page) => page.category).filter((value): value is string => !!value))];

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
          Reload the page to try again. If charts have not been installed, follow the instructions below.
        </p>
        <ChartInstallHelp />
      </div>
    );
  }

  if (manifest && manifest.pages.length === 0) {
    return (
      <div className="card">
        <h2>Charts</h2>
        <p>No chart bundle is installed.</p>
        <ChartInstallHelp />
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
            {manifest.sourcePdf && (
              <a href={`${manifest.sourcePdf}#page=${pageNum}`} target="_blank" rel="noopener noreferrer">Original PDF</a>
            )}
            {pageNum === 2 && manifest.terrainVector && (
              <a href={manifest.terrainVector} target="_blank" rel="noopener noreferrer">Vector terrain map</a>
            )}
          </div>
        </div>
        <p className="charts-blurb">
          <strong>{currentPage.title}</strong>
          {currentPage.blurb ? <span> — {currentPage.blurb}</span> : null}
        </p>
        <div className="charts-search">
          <label>
            Search all charts
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Navaid, frequency, procedure…" />
          </label>
          <label>
            Section
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="All">All sections</option>
              {categories.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <span className="charts-search-count" role="status">{visiblePages.length} of {pages.length} pages</span>
        </div>
      </div>

      <div className="charts-body">
        <nav className="charts-strip" aria-label="Chart pages" ref={stripRef}>
          {visiblePages.length === 0 && <p>No charts match this search.</p>}
          {visiblePages.map((p) => (
            <button
              key={p.page}
              type="button"
              data-page={p.page}
              className={"charts-strip-item" + (p.page === pageNum ? " charts-strip-item-active" : "")}
              onClick={() => goTo(p.page)}
              title={`${p.title}${p.chartTag ? ` (${p.chartTag})` : ""}`}
              aria-current={p.page === pageNum ? "page" : undefined}
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
          {imageError === currentPage.file ? (
            <div className="charts-viewer-error">
              <p>This chart image could not be loaded.</p>
              <button type="button" onClick={() => setImageError(null)}>Retry image</button>
              {manifest.sourcePdf && <a href={`${manifest.sourcePdf}#page=${pageNum}`} target="_blank" rel="noopener noreferrer">Open the original PDF page</a>}
            </div>
          ) : (
          <img
            key={currentPage.file}
            src={currentPage.file}
            alt={`Page ${currentPage.page}: ${currentPage.title}`}
            style={viewerStyle}
            draggable={false}
            onError={() => setImageError(currentPage.file)}
          />
          )}
        </div>
      </div>

      <details key={currentPage.page} className="card charts-reference">
        <summary>Read and copy this page's reference text</summary>
        <p>For diagram positions, symbols, and table layout, use the chart image or original PDF.</p>
        <pre>{currentPage.text || "This page has no extractable text. Use the original chart image."}</pre>
      </details>

      <div className="card charts-footer">
        <p>
          Source: {manifest.sourceUrl ? <a href={manifest.sourceUrl} target="_blank" rel="noopener noreferrer">{manifest.source}</a> : manifest.source}. Licensed{" "}
          <a
            href={manifest.licenseUrl ?? "https://creativecommons.org/licenses/by-nc-sa/3.0/"}
            target="_blank"
            rel="noopener noreferrer"
          >
            {manifest.license}
          </a>{" "}
          by {manifest.author ?? "alexustas / ASET Aviation Agency"}. Published 25 November 2017.
          All 22 original pages are included; extracted text supplements the original diagrams.
        </p>
        {manifest.referenceData && <p><a href={manifest.referenceData} target="_blank" rel="noopener noreferrer">Download the complete reference data</a></p>}
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
