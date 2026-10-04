import { useMemo, useState } from "react";
import { queryKeys } from "../query/client";
import { apiCall, describeQueryError, useApiMutation, useApiQuery } from "../query/hooks";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";
import { KerbinTowerMap, type KerbinReadOnlyMapPin } from "./KerbinTowerMap";
import type { WorldInventory } from "../data/worldInventoryClient";
import type { ActiveAircraftWire } from "../tower/towerAircraftTracks";

type WallSchematicCatalog = Parameters<
  (typeof import("./SystemSchematic"))["SystemSchematic"]
>[0]["catalog"];

type DragonRadarBallWire = {
  id: string;
  bodyName: string;
  lat: number;
  lon: number;
  aslAlt: number;
  carrierSessionId?: string;
  collectedBySessionId?: string;
};

type DragonRadarCrewReviveOfferWire = {
  offeredAt?: string;
  targetSessionId?: string;
  consumedAt?: string;
};

type DragonRadarStateWire = {
  gameId: string;
  bodyName: string;
  balls: DragonRadarBallWire[];
  crewReviveOffer?: DragonRadarCrewReviveOfferWire | null;
};

type DragonRadarRulesWire = {
  playerRangeKm: number;
  carrierRangeKm: number;
  detailRangeKm: number;
  claimRadiusM: number;
};

type DragonRadarGetRes = {
  ok?: boolean;
  state: DragonRadarStateWire | null;
  rules?: DragonRadarRulesWire;
};

type DragonRadarStartRes = { ok?: boolean; state: DragonRadarStateWire; rules?: DragonRadarRulesWire };

function trimSid(s: string | undefined, max = 10): string {
  const t = (s ?? "").trim();
  if (!t) return "—";
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function resolveHolderLabel(
  sessionIdKey: string | undefined,
  labels: ReadonlyMap<string, string>
): string {
  const k = (sessionIdKey ?? "").trim();
  if (!k) return "—";
  const fromMap = labels.get(k);
  if (fromMap) return `${fromMap} (${trimSid(k)})`;
  return trimSid(k);
}

type ActiveAircraftRes = { ok?: boolean; aircraft?: ActiveAircraftWire[] };

export type TowerDragonRadarWallSlotProps = {
  sessionId: string;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
  catalog: WallSchematicCatalog | null;
  slotPersistKey: string;
};

/**
 * Tower wall monitor: Dragon Radar map + ball roster for spectators. Claim, combat, and hail
 * are in-game (RAD / ghost hits / ACARS) — not tower-operator controls.
 */
export function TowerDragonRadarWallSlot({
  sessionId,
  worldInventory,
  homeBodyName,
  catalog,
  slotPersistKey
}: TowerDragonRadarWallSlotProps): JSX.Element {
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const [actionHint, setActionHint] = useState<string | null>(null);

  const effectiveHome =
    homeBodyName != null && String(homeBodyName).trim().length > 0
      ? String(homeBodyName).trim()
      : worldInventory?.home.name ?? "Kerbin";

  const dragonRadarQuery = useApiQuery<DragonRadarGetRes>({
    queryKey: queryKeys.session.dragonRadar(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/dragon-radar`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : 2_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });

  const aircraftQuery = useApiQuery<ActiveAircraftRes>({
    queryKey: queryKeys.tower.activeAircraft(),
    path: "/v1/tower/active-aircraft",
    refetchInterval: liveConnected ? false : 3_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const aircraft = aircraftQuery.data?.aircraft ?? [];

  const startDragonRadar = useApiMutation<DragonRadarStartRes, void>({
    mutationFn: async () => {
      const path = `/v1/session/${encodeURIComponent(sessionId)}/dragon-radar/start`;
      return apiCall<DragonRadarStartRes>(path, {
        method: "POST",
        body: JSON.stringify({ bodyName: effectiveHome })
      });
    },
    invalidate: [queryKeys.session.dragonRadar(sessionId)],
    onSuccess: () => setActionHint("Game started.")
  });

  const dragonState = dragonRadarQuery.data?.state ?? null;
  const dragonRules = dragonRadarQuery.data?.rules ?? null;

  const sessionHolderLabels = useMemo(() => {
    const m = new Map<string, string>();
    const room = sessionId.trim();
    if (room) m.set(room, "This room");
    for (const a of aircraft) {
      const id = (a.sessionId ?? "").trim();
      if (!id) continue;
      const lbl =
        (a.callsign ?? "").trim() ||
        (a.craftName ?? "").trim() ||
        (a.pilotName ?? "").trim() ||
        id.slice(0, 8);
      m.set(id, lbl);
    }
    return m;
  }, [aircraft, sessionId]);

  const { dragonSummary, readOnlyOverlayPins, ballRows } = useMemo(() => {
    const emptyPins: KerbinReadOnlyMapPin[] = [];
    if (!dragonState?.balls?.length) {
      return {
        dragonSummary: { loose: 0, carried: 0, collected: 0 },
        readOnlyOverlayPins: emptyPins,
        ballRows: [] as Array<{
          id: string;
          lat: string;
          lon: string;
          asl: string;
          status: string;
          holder: string;
        }>
      };
    }
    let loose = 0;
    let carried = 0;
    let collected = 0;
    const pins: KerbinReadOnlyMapPin[] = [];
    const rows: Array<{ id: string; lat: string; lon: string; asl: string; status: string; holder: string }> = [];
    const sorted = [...dragonState.balls].filter((b) => b?.id).sort((a, b) => a.id.localeCompare(b.id));
    for (const b of sorted) {
      if (!b?.id) continue;
      const hasCarrier = !!b.carrierSessionId?.trim();
      const isCollected = !!b.collectedBySessionId?.trim();
      const st = isCollected ? "collected" : hasCarrier ? "carried" : "loose";
      if (st === "collected") collected++;
      else if (st === "carried") carried++;
      else loose++;
      const holderSid = isCollected ? b.collectedBySessionId : hasCarrier ? b.carrierSessionId : "";
      const holder = resolveHolderLabel(holderSid, sessionHolderLabels);
      rows.push({
        id: b.id,
        lat: Number.isFinite(b.lat) ? b.lat.toFixed(4) : "—",
        lon: Number.isFinite(b.lon) ? b.lon.toFixed(4) : "—",
        asl: Number.isFinite(b.aslAlt) ? String(Math.round(b.aslAlt)) : "—",
        status: st,
        holder
      });

      if (!isCollected) {
        const hs = (holderSid ?? "").trim();
        const shortHolder = hs ? sessionHolderLabels.get(hs) ?? trimSid(holderSid, 8) : "";
        pins.push({
          id: `dragon-ball:${b.id}`,
          lat: b.lat,
          lon: b.lon,
          bodyName: b.bodyName,
          label: hasCarrier ? `${b.id.toUpperCase()} · ${shortHolder || "carried"}` : b.id.toUpperCase(),
          color: hasCarrier ? "#f472b6" : "#fbbf24"
        });
      }
    }
    return {
      dragonSummary: { loose, carried, collected },
      readOnlyOverlayPins: pins,
      ballRows: rows
    };
  }, [dragonState, sessionHolderLabels]);

  return (
    <div className="tower-dragon-wall">
      <header className="tower-dragon-wall__head">
        <div>
          <div className="tower-dragon-wall__title">Dragon Radar</div>
          <div className="tower-dragon-wall__sub">
            Spectator map and ball roster — <strong>no pilot actions here</strong>. Pilots claim balls and fight in
            KSP (RAD + ghost traffic). Hail uses <strong>in-game ACARS</strong>. When this room holds all seven balls,
            the <strong>crew-restore wish</strong> applies once from RAD.
          </div>
        </div>
        <div className="tower-dragon-wall__actions">
          <button
            type="button"
            className="tower-dragon-wall__btn tower-dragon-wall__btn--primary"
            disabled={!sessionId || startDragonRadar.isPending}
            onClick={() => startDragonRadar.mutate()}
          >
            {startDragonRadar.isPending ? "Starting…" : "Start game"}
          </button>
          <button
            type="button"
            className="tower-dragon-wall__btn"
            disabled={dragonRadarQuery.isFetching}
            onClick={() => void dragonRadarQuery.refetch()}
          >
            Refresh
          </button>
        </div>
      </header>

      {dragonRadarQuery.error ? (
        <p className="tower-dragon-wall__err">{describeQueryError(dragonRadarQuery.error)}</p>
      ) : null}
      {aircraftQuery.error ? (
        <p className="tower-dragon-wall__err">{describeQueryError(aircraftQuery.error)}</p>
      ) : null}
      {startDragonRadar.error ? (
        <p className="tower-dragon-wall__err">{describeQueryError(startDragonRadar.error)}</p>
      ) : null}
      {actionHint ? <p className="tower-dragon-wall__hint tower-dragon-wall__hint--ok">{actionHint}</p> : null}

      {!dragonState ? (
        <p className="tower-dragon-wall__muted">No active Dragon Radar map for this room yet.</p>
      ) : (
        <>
          <div className="tower-dragon-wall__meta">
            <span>
              Map <span className="tower-dragon-wall__mono">{dragonState.gameId}</span>
            </span>
            <span>
              Game body <span className="tower-dragon-wall__mono">{dragonState.bodyName}</span>
            </span>
            <span>
              Loose {dragonSummary.loose} · Carried {dragonSummary.carried} · Collected {dragonSummary.collected}
            </span>
          </div>
          {dragonRules ? (
            <div className="tower-dragon-wall__rules-explained">
              <div className="tower-dragon-wall__rules-explained-title">Distance rules (same numbers as in-game RAD)</div>
              <ul className="tower-dragon-wall__rules-list">
                <li>
                  <strong>Other pilots ({dragonRules.playerRangeKm} km)</strong> — A player blip is only drawn if their
                  telemetry is within this <em>slant range</em> (straight-line km) from your ship. Bearing is always
                  true; how far along the ring they sit scales with distance up to this cap.
                </li>
                <li>
                  <strong>Ball carriers ({dragonRules.carrierRangeKm} km)</strong> — Someone holding a dragon ball
                  stays visible farther out (out to this km). Beyond the pilot range they pin to the <em>outer ring</em>{" "}
                  as a direction-only “over there” cue.
                </li>
                <li>
                  <strong>Ball detail ({dragonRules.detailRangeKm} km)</strong> — Loose balls use a bigger, labeled
                  blip inside this range; farther away (but still within carrier range) they shrink to the coarse blip on
                  the rim.
                </li>
                <li>
                  <strong>Claim ({dragonRules.claimRadiusM} m)</strong> — Pick up a loose ball in RAD: you must be{" "}
                  <em>landed</em> (or splashed) and within this many <em>horizontal</em> metres (great-circle on the
                  body) of the ball&apos;s latitude/longitude — same check as the server and the CLAIM button.
                </li>
              </ul>
            </div>
          ) : null}
          {(dragonState.bodyName ?? "").trim().toLowerCase() !== "kerbin" ? (
            <p className="tower-dragon-wall__hint">
              Game is on {dragonState.bodyName}. Use the map body control (top bar) to view that body if your planet
              pack exposes it — pins are omitted when the viewed body does not match a ball&apos;s body.
            </p>
          ) : null}

          {dragonState.crewReviveOffer && !dragonState.crewReviveOffer.consumedAt ? (
            <p className="tower-dragon-wall__hint tower-dragon-wall__hint--reward">
              <strong>Crew-restore wish pending.</strong> This room holds all seven balls on the server — keep RAD open
              in KSP to apply the one-time roster restore (Dead/Missing kerbals → Available). A system line is also
              posted to room ACARS.
            </p>
          ) : null}
          {dragonState.crewReviveOffer?.consumedAt ? (
            <p className="tower-dragon-wall__hint tower-dragon-wall__hint--ok">
              Crew-restore wish consumed — hunt can continue, but this reward will not fire again until the next Dragon
              Radar game.
            </p>
          ) : null}

          <div className="tower-dragon-wall__panel" aria-label="Ball roster">
            <div className="tower-dragon-wall__panel-title">Balls (position + holder)</div>
            {ballRows.length === 0 ? (
              <p className="tower-dragon-wall__muted">No ball rows.</p>
            ) : (
              <div className="tower-dragon-wall__table-wrap">
                <table className="tower-dragon-wall__table">
                  <thead>
                    <tr>
                      <th scope="col">Ball</th>
                      <th scope="col">Lat</th>
                      <th scope="col">Lon</th>
                      <th scope="col">ASL m</th>
                      <th scope="col">Status</th>
                      <th scope="col">Holder (tower session)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ballRows.map((r) => (
                      <tr key={r.id}>
                        <td className="tower-dragon-wall__mono">{r.id}</td>
                        <td className="tower-dragon-wall__mono">{r.lat}</td>
                        <td className="tower-dragon-wall__mono">{r.lon}</td>
                        <td className="tower-dragon-wall__mono">{r.asl}</td>
                        <td>{r.status}</td>
                        <td>{r.holder}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="tower-dragon-wall__muted tower-dragon-wall__table-foot">
              Holder names come from live <span className="tower-dragon-wall__mono">/v1/tower/active-aircraft</span>{" "}
              when that session is on frequency; otherwise you still see the short session id.
            </p>
          </div>
        </>
      )}

      <div className="tower-dragon-wall__map">
        <KerbinTowerMap
          sessionId={sessionId}
          telemetry={null}
          towerAircraft={null}
          worldInventory={worldInventory}
          systemCatalog={catalog}
          persistKey={`${slotPersistKey}-dragon-radar`}
          wallSlot
          suppressAircraftOverlay
          suppressSharedWaypointPins
          readOnlyOverlayPins={readOnlyOverlayPins}
        />
      </div>
    </div>
  );
}
