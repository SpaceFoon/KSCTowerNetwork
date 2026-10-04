import { useMemo, useState } from "react";
import { queryKeys } from "../query/client";
import { useApiQuery } from "../query/hooks";
import { HullCamTile, type CameraSummary } from "./HullCamPanel";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";

/**
 * Tower View panel: renders live "look out the tower window" hullcam streams that any
 * authenticated KSP client can publish via the radio panel's "Stream as Tower" toggle.
 *
 * Backend shape:
 *   - `GET /v1/tower/view-streams` -> `{ ok, serverNowMs, staleMs, streams: [{ sessionId, cameras }] }`
 *   - Cameras inside each stream use the same `KSC-TOWER-*` session id namespace and reuse the
 *     existing `/v1/hullcam/{sessionId}/{cameraId}/snapshot.jpg` endpoint, so we delegate the
 *     actual JPEG-poll/LOS lifecycle to `HullCamTile`. This panel is just discovery + grid.
 *
 * UX notes:
 *   - Streams disappear from the list ~10 s after their publisher stops (matches
 *     `HULLCAM_STALE_MS` on the backend), so we don't need an explicit "offline" state here.
 *   - Defaults to the first stream selected; clicking a thumbnail swaps the big tile to that
 *     stream. Single-stream (the common case) hides the picker entirely.
 *   - Returns `null` when nothing is being broadcast so the card collapses into the layout
 *     instead of showing an "awaiting feed" placeholder forever.
 */

const STREAMS_POLL_MS = 4_000;

type TowerViewStream = {
  sessionId: string;
  cameras: CameraSummary[];
};

type TowerViewStreamsResponse = {
  ok: true;
  serverNowMs: number;
  staleMs: number;
  streams: TowerViewStream[];
};

export function TowerViewPanel(): JSX.Element | null {
  const liveConnected = useTowerLiveSubscriptions("");
  const q = useApiQuery<TowerViewStreamsResponse>({
    queryKey: queryKeys.tower.viewStreams(),
    path: `/v1/tower/view-streams`,
    refetchInterval: liveConnected ? false : STREAMS_POLL_MS,
    placeholderData: (prev) => prev
  });

  const streams = useMemo<TowerViewStream[]>(
    () => (Array.isArray(q.data?.streams) ? q.data!.streams : []),
    [q.data]
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selected =
    streams.find((s) => s.sessionId === selectedSessionId) ?? streams[0] ?? null;

  // Pre-fetch state — keep the layout from flashing an empty card on first paint.
  if (!q.isFetched && streams.length === 0) {
    return null;
  }

  // Loaded but nobody is broadcasting "Stream as Tower" right now — render an
  // explanatory placeholder rather than `return null` so the card stays
  // populated and the feature is discoverable to controllers / first-time users.
  // (Mirrors HullCamPanel's "Awaiting feed" empty state.)
  if (streams.length === 0 || selected == null || selected.cameras.length === 0) {
    return (
      <section className="tower-view-panel" aria-label="Tower View streams">
        <header className="tower-view-panel__head">
          <h3 className="tower-view-panel__title">TOWER VIEW</h3>
          <span className="tower-view-panel__sub">No streams</span>
        </header>
        <p className="tower-view-panel__empty">
          No-one is streaming the tower window right now. A tower-eligible KSP client in{" "}
          <strong>flight</strong> at KSC (HullCam + JRTI, CAM relay on) publishes here with{" "}
          <strong>TWR</strong> (“Stream as Tower”) on the radio panel — see{" "}
          <code>GameData/KSCTowerNetwork/PluginData/TOWER_CAM_README.txt</code> in the mod install.
        </p>
      </section>
    );
  }

  const showPicker = streams.length > 1;
  const featuredCam =
    [...selected.cameras].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;

  return (
    <section className="tower-view-panel" aria-label="Tower View streams">
      <header className="tower-view-panel__head">
        <h3 className="tower-view-panel__title">TOWER VIEW</h3>
        <span className="tower-view-panel__sub">
          {streams.length} live stream{streams.length === 1 ? "" : "s"}
        </span>
      </header>

      {featuredCam ? (
        <div className="tower-view-panel__featured">
          <HullCamTile sessionId={selected.sessionId} camera={featuredCam} />
        </div>
      ) : null}

      {showPicker ? (
        <div className="tower-view-panel__picker" role="tablist" aria-label="Tower View sources">
          {streams.map((s) => {
            const active = s.sessionId === selected.sessionId;
            return (
              <button
                type="button"
                key={s.sessionId}
                role="tab"
                aria-selected={active}
                className={"tower-view-panel__pick" + (active ? " is-active" : "")}
                onClick={() => setSelectedSessionId(s.sessionId)}
                title={s.sessionId}
              >
                {labelFor(s.sessionId)}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Friendly short label for a `KSC-TOWER-{sha1...}` session id. We can't recover the publisher's
 * display name without an extra round-trip, so the suffix is just a stable visual handle to
 * tell streams apart when more than one is live.
 */
function labelFor(sessionId: string): string {
  const suffix = sessionId.replace(/^KSC-TOWER-/, "");
  return suffix.length > 6 ? `Twr ${suffix.slice(0, 6)}` : `Twr ${suffix}`;
}
