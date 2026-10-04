import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { queryKeys } from "../query/client";
import { apiCall, useApiQuery } from "../query/hooks";

/**
 * KosScreenPanel: live mirror of in-game kOS PRINT-style output for the active
 * Tower session. Polls `/v1/session/{sessionId}/kos-screen?since=<iso>` on a
 * fixed cadence and appends new lines into a bounded local ring.
 *
 * Pipe shape (one-way, kOS -> web):
 *   in-game kOS terminal output (any PRINT, any script, including KOSmodore)
 *     -> TowerKosScreenAutoCapture walks every kOSProcessor, diffs IScreenBufferLine
 *        by LastChangeTick, POSTs changed lines
 *     -> backend stores in session_kos_screen
 *     -> this panel polls and renders in a VT-style monospace block.
 *
 * Phase 2 (documented in docs/PLUGIN.md): interactive remote terminal via the
 * kOS telnet server is intentionally out of scope here.
 *
 * Why it doesn't use a plain `useApiQuery` for the polled fetch: the endpoint
 * uses a `?since=` cursor so each tick must read the most recent timestamp
 * before issuing the next request. We use TanStack Query for the *initial*
 * load (so the panel benefits from cache + auto-retry on first paint), then
 * own a small incremental poller after that.
 */

const POLL_MS = 2_000;
/** Hard cap on the in-component ring so a long uptime can't OOM the renderer. */
const MAX_LINES = 200;

type KosLine = {
  id: string;
  sessionId: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type KosScreenResponse = {
  ok: true;
  lines: KosLine[];
};

type Props = {
  sessionId: string;
};

export function KosScreenPanel({ sessionId }: Props): JSX.Element | null {
  const [lines, setLines] = useState<KosLine[]>([]);
  const [emptySinceMs, setEmptySinceMs] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const sinceRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial load via TanStack Query — gives us cache, retry, and a clean
  // "we've actually pinged the server once" signal via `isFetched`.
  const initialQuery = useApiQuery<KosScreenResponse>({
    queryKey: queryKeys.session.kosScreen(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/kos-screen`,
    enabled: !!sessionId,
    // We fold this initial payload into local state below; re-fetching would
    // duplicate lines because we use a since-cursor for incremental polls.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity
  });

  // Once the initial load returns, seed local state and start the incremental
  // poller. Reset everything when the session changes — the previous session's
  // lines must not bleed into the new panel.
  useEffect(() => {
    if (!sessionId) {
      setLines([]);
      sinceRef.current = "";
      return;
    }
    if (!initialQuery.data) return;
    const fresh = Array.isArray(initialQuery.data.lines) ? initialQuery.data.lines : [];
    setLines(fresh.length > MAX_LINES ? fresh.slice(fresh.length - MAX_LINES) : fresh);
    sinceRef.current = fresh[fresh.length - 1]?.createdAt ?? "";
  }, [sessionId, initialQuery.data]);

  useEffect(() => {
    if (!sessionId || !initialQuery.isFetched) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const url = sinceRef.current
        ? `/v1/session/${encodeURIComponent(sessionId)}/kos-screen?since=${encodeURIComponent(sinceRef.current)}`
        : `/v1/session/${encodeURIComponent(sessionId)}/kos-screen`;
      try {
        const data = await apiCall<KosScreenResponse>(url);
        if (cancelled) return;
        const fresh = Array.isArray(data.lines) ? data.lines : [];
        if (fresh.length > 0) {
          setLines((prev) => {
            const merged = prev.concat(fresh);
            return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
          });
          const newest = fresh[fresh.length - 1]?.createdAt;
          if (newest && (!sinceRef.current || newest > sinceRef.current)) {
            sinceRef.current = newest;
          }
        }
      } catch {
        // Transient errors are silent — the next tick retries. The initial
        // query handles surfacing a permanent failure.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    };

    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, initialQuery.isFetched]);

  // Track how long the line list has been empty so we can shift from
  // "Connecting…" to "Waiting for kOS terminal output…" after the auto-capture
  // has had a real chance to deliver something. No more opt-in instructions —
  // the in-game plugin auto-captures every kOS CPU's terminal whenever the
  // KOS toggle on the cockpit radio panel is on (default), so an empty panel
  // just means "nothing has printed yet on this channel".
  useEffect(() => {
    if (!initialQuery.isFetched) {
      setEmptySinceMs(null);
      return;
    }
    if (lines.length > 0) {
      setEmptySinceMs(null);
      return;
    }
    setEmptySinceMs((prev) => prev ?? Date.now());
  }, [initialQuery.isFetched, lines.length]);

  // Auto-scroll to bottom when new lines arrive, but only when the user hasn't
  // scrolled up to read history. useLayoutEffect avoids a frame of jitter when
  // the panel is near the fold.
  useLayoutEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Treat "within 24 px of bottom" as still-following so a small mousewheel
    // overshoot doesn't disable auto-scroll.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow((prev) => (prev === atBottom ? prev : atBottom));
  }, []);

  const onClear = useCallback(() => {
    // Local-only clear: server history is preserved and will reappear on next
    // session change / page reload. Useful for cleaning up after a loud script
    // without losing the audit trail on the backend.
    setLines([]);
  }, []);

  if (!sessionId) {
    return null;
  }

  const longSinceEmpty =
    lines.length === 0 && emptySinceMs != null && Date.now() - emptySinceMs > 8_000;

  return (
    <section className="kos-screen-panel" aria-label="kOS screen mirror">
      <header className="kos-screen-panel__head">
        <h2>kOS screen</h2>
        <div className="kos-screen-panel__controls">
          <span
            className={"kos-screen-panel__follow " + (follow ? "kos-screen-panel__follow--on" : "kos-screen-panel__follow--off")}
            title={follow ? "Auto-scrolling with new lines" : "Scroll to bottom to resume auto-scroll"}
          >
            {follow ? "FOLLOWING" : "PAUSED"}
          </span>
          <button type="button" onClick={onClear} disabled={lines.length === 0} aria-label="Clear local view">
            Clear
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="kos-screen-panel__viewport"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {lines.length === 0 ? (
          <p className="kos-screen-panel__empty">
            {!initialQuery.isFetched
              ? "Connecting…"
              : longSinceEmpty
                ? "Waiting for kOS — toggle KOS on the cockpit panel if it's off."
                : "Waiting for kOS terminal output…"}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="kos-screen-panel__line">
              <span className="kos-screen-panel__time">{formatLineTime(line.createdAt)}</span>
              <span className="kos-screen-panel__body">{line.body}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function formatLineTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
