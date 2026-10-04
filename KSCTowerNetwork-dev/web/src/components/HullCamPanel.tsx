import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase, getStoredToken } from "../api/client";
import { queryKeys } from "../query/client";
import { useApiQuery } from "../query/hooks";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";

/**
 * HullCam panel: shows JPEG snapshots that the pilot's KSP plugin (`TowerHullCamRelay`)
 * pushes to the backend at ~1 Hz from the local JustReadTheInstructions HTTP server.
 *
 * Polling shape:
 *   - `/v1/hullcam/{sessionId}` is polled every 2 s for the active camera list.
 *   - Each tile fetches `/v1/hullcam/{sessionId}/{cameraId}/snapshot.jpg` at ~1 Hz via
 *     authenticated `fetch`+`Blob`+object URL (we cannot use a plain <img src> because
 *     the backend requires a bearer token, and there is no cookie session).
 *   - A frame older than `STALE_FRAME_MS` (6 s) flips the tile to a "LOS" placeholder.
 *
 * Off by default on the pilot side, so an empty list is the normal state when the
 * mod hasn't been enabled or the player isn't in flight.
 */

const CAMERA_LIST_POLL_MS = 2_000;
const FRAME_POLL_MS = 1_000;
const STALE_FRAME_MS = 6_000;
const EMPTY_LIST_HINT_AFTER_MS = 5_000;

export type CameraSummary = {
  id: number;
  name: string;
  updatedAtMs: number;
  snapshotUrl: string;
};

type CameraListResponse = {
  ok: true;
  sessionId: string;
  cameras: CameraSummary[];
  serverNowMs: number;
  staleMs: number;
};

/**
 * Polls `/v1/hullcam/{sessionId}` for the live camera list. Exposed so the TowerWall
 * page can populate its per-monitor source picker with the same cameras the panel
 * sees, without re-implementing the polling shape (and without two pollers running
 * for the same data when the wall is showing a hullcam slot next to the panel).
 */
export function useHullCamList(sessionId: string): {
  cameras: CameraSummary[];
  loadedOnce: boolean;
} {
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const q = useApiQuery<CameraListResponse>({
    queryKey: queryKeys.session.hullCamCameras(sessionId),
    path: `/v1/hullcam/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? CAMERA_LIST_POLL_MS : false,
    placeholderData: (prev) => prev
  });
  return {
    cameras: Array.isArray(q.data?.cameras) ? q.data!.cameras : [],
    loadedOnce: q.isFetched
  };
}

type Props = {
  sessionId: string;
  /** When set, render only this many tiles in compact mode (used by VoiceDesk). */
  compact?: boolean;
};

export function HullCamPanel({ sessionId, compact = false }: Props): JSX.Element | null {
  const { cameras, loadedOnce } = useHullCamList(sessionId);
  const [emptySinceMs, setEmptySinceMs] = useState<number | null>(null);
  const [expandedCameraId, setExpandedCameraId] = useState<number | null>(null);

  // Track how long the camera list has been empty so we only show the help blurb after
  // the relay's had a real chance to push frames (mod-not-installed vs. brief blip).
  useEffect(() => {
    if (cameras.length === 0) {
      setEmptySinceMs((prev) => prev ?? Date.now());
    } else {
      setEmptySinceMs(null);
    }
  }, [cameras.length]);

  // Drop the expanded modal if its camera went away (vessel switch, mod disabled, etc).
  useEffect(() => {
    if (expandedCameraId == null) return;
    if (!cameras.some((c) => c.id === expandedCameraId)) {
      setExpandedCameraId(null);
    }
  }, [cameras, expandedCameraId]);

  const showEmptyHint =
    loadedOnce &&
    cameras.length === 0 &&
    emptySinceMs !== null &&
    Date.now() - emptySinceMs > EMPTY_LIST_HINT_AFTER_MS;

  // Hide entirely when we have no data yet so we don't paint an empty box on first load.
  if (!loadedOnce && cameras.length === 0) {
    return null;
  }

  // Compact mode: show one tile (the most recently-updated camera) without chrome.
  if (compact) {
    const newest = [...cameras].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    if (!newest) return null;
    return (
      <div className="hullcam-panel hullcam-panel--compact">
        <HullCamTile
          sessionId={sessionId}
          camera={newest}
          onExpand={() => setExpandedCameraId(newest.id)}
        />
        {expandedCameraId != null ? (
          <ExpandedCameraModal
            sessionId={sessionId}
            camera={cameras.find((c) => c.id === expandedCameraId) ?? newest}
            onClose={() => setExpandedCameraId(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section className="hullcam-panel" aria-label="HullCam feeds">
      <header className="hullcam-panel__head">
        <h3 className="hullcam-panel__title">HULLCAM</h3>
        <span className="hullcam-panel__sub">
          {cameras.length > 0
            ? `${cameras.length} camera${cameras.length === 1 ? "" : "s"} live`
            : "Awaiting feed"}
        </span>
      </header>

      {cameras.length === 0 ? (
        <p className="hullcam-panel__empty">
          {showEmptyHint
            ? "Pilot has no HullCams streaming. Requires Hullcam VDS Continued + JustReadTheInstructions on the pilot side, with the relay enabled in the radio settings. Other camera mods (Neptune Camera, KURS DockingCam) are not supported."
            : "Awaiting first frame from pilot…"}
        </p>
      ) : (
        <div className="hullcam-panel__grid">
          {cameras.map((cam) => (
            <HullCamTile
              key={cam.id}
              sessionId={sessionId}
              camera={cam}
              onExpand={() => setExpandedCameraId(cam.id)}
            />
          ))}
        </div>
      )}

      {expandedCameraId != null
        ? (() => {
            const cam = cameras.find((c) => c.id === expandedCameraId);
            return cam ? (
              <ExpandedCameraModal
                sessionId={sessionId}
                camera={cam}
                onClose={() => setExpandedCameraId(null)}
              />
            ) : null;
          })()
        : null}
    </section>
  );
}

/**
 * Single video-tile that pulls a fresh JPEG via authenticated fetch every FRAME_POLL_MS.
 * Exported (as `HullCamTile`) so the TowerWall page can drop a single camera into a
 * monitor slot without re-implementing the polling/LOS state machine.
 *
 * The tile uses the parent's width; the feed is letterboxed inside a square frame
 * (`aspect-ratio: 1/1`, `object-fit: contain`) so pixels are never stretched.
 */
export function HullCamTile({
  sessionId,
  camera,
  onExpand
}: {
  sessionId: string;
  camera: CameraSummary;
  /** Optional: when omitted the tile is a static block (no click-to-expand). */
  onExpand?: () => void;
}): JSX.Element {
  const { objectUrl, lastFrameMs, los } = useFramePoller(sessionId, camera.id);
  const clickable = typeof onExpand === "function";

  return (
    <button
      type="button"
      className={"hullcam-tile" + (los ? " hullcam-tile--los" : "") + (clickable ? "" : " hullcam-tile--static")}
      onClick={clickable ? onExpand : undefined}
      aria-label={clickable ? `Expand ${camera.name}` : camera.name}
      disabled={!clickable}
    >
      {los || objectUrl == null ? (
        <div className="hullcam-tile__los">
          <span>SIGNAL LOST</span>
        </div>
      ) : (
        <img
          className="hullcam-tile__img"
          src={objectUrl}
          alt={`HullCam ${camera.name}`}
          draggable={false}
        />
      )}
      <div className="hullcam-tile__caption">
        <span className="hullcam-tile__name" title={camera.name}>
          {camera.name}
        </span>
        <span className="hullcam-tile__age">
          {lastFrameMs != null ? formatAge(Date.now() - lastFrameMs) : "—"}
        </span>
      </div>
    </button>
  );
}

function ExpandedCameraModal({
  sessionId,
  camera,
  onClose
}: {
  sessionId: string;
  camera: CameraSummary;
  onClose: () => void;
}): JSX.Element {
  const { objectUrl, lastFrameMs, los } = useFramePoller(sessionId, camera.id);

  // ESC closes the modal, matching the rest of the app's overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="hullcam-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="hullcam-modal" onClick={(e) => e.stopPropagation()}>
        <header className="hullcam-modal__head">
          <div>
            <h2>{camera.name}</h2>
            <span className="hullcam-modal__sub">
              {lastFrameMs != null ? `frame ${formatAge(Date.now() - lastFrameMs)} old` : "no frame yet"}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close camera view">
            ✕
          </button>
        </header>
        <div className={"hullcam-modal__viewport" + (los ? " hullcam-modal__viewport--los" : "")}>
          {los || objectUrl == null ? (
            <div className="hullcam-modal__los">SIGNAL LOST</div>
          ) : (
            <img className="hullcam-modal__img" src={objectUrl} alt={`HullCam ${camera.name}`} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Polls a snapshot endpoint every FRAME_POLL_MS using bearer-authenticated fetch and exposes
 * a stable object URL plus LOS state. Object URLs are revoked on swap so the browser doesn't
 * accumulate JPEGs in memory across hours of flight.
 */
export function useFramePoller(sessionId: string, cameraId: number): {
  objectUrl: string | null;
  lastFrameMs: number | null;
  los: boolean;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [lastFrameMs, setLastFrameMs] = useState<number | null>(null);
  const [los, setLos] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const lastFrameRef = useRef<number | null>(null);

  // Keep refs in sync so the polling loop can read them without re-running the effect on
  // every frame (which would tear down the timer chain).
  useEffect(() => {
    objectUrlRef.current = objectUrl;
  }, [objectUrl]);
  useEffect(() => {
    lastFrameRef.current = lastFrameMs;
  }, [lastFrameMs]);

  const fetchOne = useCallback(async (): Promise<void> => {
    const base = getApiBase();
    const url =
      (base ? base : "") +
      `/v1/hullcam/${encodeURIComponent(sessionId)}/${cameraId}/snapshot.jpg`;
    const headers: HeadersInit = {};
    const token = getStoredToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch {
      return; // network blip; LOS will kick in via the staleness check below
    }

    if (res.status === 503 || res.status === 404) {
      return; // backend says no fresh frame; let the staleness check decide LOS
    }
    if (!res.ok) {
      return;
    }

    const blob = await res.blob();
    if (blob.size === 0) return;
    const next = URL.createObjectURL(blob);
    const prev = objectUrlRef.current;
    setObjectUrl(next);
    setLastFrameMs(Date.now());
    if (prev) {
      // Revoke the old URL after the next paint so the <img> swap doesn't flicker.
      setTimeout(() => URL.revokeObjectURL(prev), 200);
    }
  }, [sessionId, cameraId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      await fetchOne();
      if (!cancelled) {
        timer = setTimeout(tick, FRAME_POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOne]);

  // Independent staleness sweeper so LOS appears even when fetchOne keeps 503-ing.
  useEffect(() => {
    const id = setInterval(() => {
      const last = lastFrameRef.current;
      setLos(last == null ? true : Date.now() - last > STALE_FRAME_MS);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Revoke the final object URL on unmount so we don't leak when the panel disappears.
  useEffect(() => {
    return () => {
      const u = objectUrlRef.current;
      if (u) URL.revokeObjectURL(u);
    };
  }, []);

  return { objectUrl, lastFrameMs, los };
}

function formatAge(ms: number): string {
  if (ms < 1500) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
