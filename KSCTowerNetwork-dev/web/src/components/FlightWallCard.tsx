import { useEffect, useState } from "react";
import type { TowerAircraftTrack } from "./KerbinTowerMap";
import { apiFetchResponse } from "../api/client";
import { flightWallGuidance } from "../tower/flightWallGuidance";

function CraftThumbnail({ sessionId, craftName, previewUrl }: { sessionId: string; craftName: string; previewUrl?: string }) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = `${sessionId}\0${craftName}`;
  useEffect(() => {
    if (previewUrl) return;
    const controller = new AbortController();
    let url: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await apiFetchResponse(`/v1/craft-thumbnail/${encodeURIComponent(sessionId)}?craftName=${encodeURIComponent(craftName)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.ok) {
          const blob = await result.response.blob();
          if (controller.signal.aborted) return;
          const next = URL.createObjectURL(blob);
          if (url) URL.revokeObjectURL(url);
          url = next;
          setImage({ key, url: next });
        } else {
          if (url) URL.revokeObjectURL(url);
          url = null;
          setImage(null);
        }
      } catch {
        if (!controller.signal.aborted) setImage(null);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 15_000);
    };
    if (craftName) void poll();
    return () => { controller.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [sessionId, craftName, key, previewUrl]);
  const source = previewUrl || (image?.key === key ? image.url : null);
  return source
    ? <img src={source} alt={`Saved craft thumbnail of ${craftName}`} onError={() => setImage(null)} />
    : <div className="flight-wall__no-photo"><svg viewBox="0 0 200 100" aria-hidden="true"><path d="M100 10 113 47 177 69 177 77 111 64 110 81 128 88 128 94 100 89 72 94 72 88 90 81 89 64 23 77 23 69 87 47Z" /></svg><span>Waiting for craft photo</span><small>Save this craft in the VAB or SPH to create a thumbnail.</small></div>;
}

const num = (value: number | undefined, digits = 0) => value != null && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";

export function FlightWallCard({ track, distanceKm, bearing, originLabel, nowMs, staleAfterMs = 15_000, previewThumbnailUrl }: {
  track: TowerAircraftTrack | null; distanceKm: number; bearing: number; originLabel: string; nowMs: number; staleAfterMs?: number; previewThumbnailUrl?: string;
}) {
  if (!track) return <aside className="flight-wall__details flight-wall__details--empty"><h2>Flightwall</h2><p>Select a craft on the radar to follow its flight.</p><small>Traffic appears when a pilot’s beacon sends a position.</small></aside>;
  const t = track.telemetry;
  const guide = flightWallGuidance(t, distanceKm, bearing, nowMs, staleAfterMs);
  return <aside className="flight-wall__details" aria-label={`Flight details for ${track.label}`}>
    <header className="flight-wall__head"><h2>{t.pilotName ? `${t.pilotName}’s flight` : "KSC flightwall"}</h2><span className={`flight-wall__signal flight-wall__signal--${guide.state}`}>{guide.state === "stale" ? "STALE" : "LIVE TRACK"}</span></header>
    <section className="flight-wall__guidance"><div><strong>{guide.title}</strong><span>{num(distanceKm, 1)} km · {guide.direction}</span></div><p>{guide.detail}</p><small>Relative to {originLabel} · north up</small></section>
    <section className="flight-wall__craft"><div className="flight-wall__photo"><CraftThumbnail key={`${track.id}:${t.craftName}`} sessionId={track.id} craftName={t.craftName || ""} previewUrl={previewThumbnailUrl} /></div><div className="flight-wall__identity"><small>CRAFT</small><h3>{track.label}</h3><p>{t.craftName || "Unnamed craft"} <span>· {t.craftType || t.craftMapIcon || "Vessel"}</span></p><small>{previewThumbnailUrl ? "LOCAL THUMBNAIL PREVIEW" : "SAVED CRAFT THUMBNAIL"}</small></div></section>
    <section className="flight-wall__facts"><div className="flight-wall__destination"><small>WHERE IS IT FLYING?</small><strong>{t.targetRunway || (t.onApproach || t.landing ? t.activeRunway : undefined) || "Destination not reported"}</strong><span>{t.bodyName || "Unknown body"} · {t.flightPhase?.replace(/_/g, " ") || t.situation?.toLowerCase() || "In flight"}</span></div><dl><div><dt>Altitude ASL</dt><dd>{num(t.aslAlt)} <small>m</small></dd></div><div><dt>Surface speed</dt><dd>{num(t.surfaceSpeed, 1)} <small>m/s</small></dd></div><div><dt>Heading</dt><dd>{num(t.heading)}<small>°</small></dd></div><div><dt>Vertical speed</dt><dd>{num(t.verticalSpeed, 1)} <small>m/s</small></dd></div></dl></section>
  </aside>;
}
