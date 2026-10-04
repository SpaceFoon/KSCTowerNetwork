import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getStoredUser, userHasCapability } from "../auth/session";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { HullCamPanel } from "../components/HullCamPanel";
import { TowerViewPanel } from "../components/TowerViewPanel";
import { VesselSchematicPanel } from "../components/VesselSchematicPanel";
import { KosScreenPanel } from "../components/KosScreenPanel";
import { BodyMap, type BodyMapVessel } from "../components/BodyMap";
import {
  KerbinTowerMap,
  KERBIN_RADIUS_M,
  KSC_LAT,
  KSC_LON,
  NEAR_KSC_M,
  formatBool,
  formatCrew,
  formatKerbinDays,
  formatFarFlapSetting,
  formatMassTons,
  formatNum,
  formatRadiation,
  kerbinDistanceMeters,
  aircraftPrimaryLabel,
  type Telemetry
} from "../components/KerbinTowerMap";
import { buildTowerAircraftTracks, type ActiveAircraftWire } from "../tower/towerAircraftTracks";
import { commsStatus, commsStatusLabel } from "../components/mapComms";
import { OffWorldTrafficPanel, type OffWorldVessel } from "../components/OffWorldTrafficPanel";
import { SystemSchematic, type VesselOrbitSpec } from "../components/SystemSchematic";
import { TowerWall, type SessionStripEmphasis } from "../components/TowerWall";
import { CountdownPanel } from "../session/CountdownPanel";
import { ClearancePanel, type SessionClearances } from "../session/ClearancePanel";
import { deriveFlightStatusPill, deriveGameLinkLabel } from "../tower/flightStatus";
import { KERBIN_NAVAIDS, type KerbinNavAid } from "../data/kerbinNavaids";
import { KERBIN_LAUNCH_SITES, type KerbinLaunchSite } from "../data/kerbinLaunchSites";
import { basemapUrlFor } from "../data/systemCatalog";
import { useSystemCatalog } from "../data/useSystemCatalog";
import {
  fetchWorldInventory,
  launchSitesForBody,
  launchSitesForHomeBody,
  navaidsForBody,
  navaidsForHomeBody,
  type WorldInventory
} from "../data/worldInventoryClient";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";
import { displayMhzFromNumber } from "../lib/displayMhz";
import { SessionHeader } from "../session/SessionHeader";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";
import { HOME_DAY_SECONDS_FALLBACK, LIFE_SUPPORT_LABEL } from "../tower/kerbalismLifeSupportLabels";

type ActivePilotRoom = {
  roomId: string;
  roomName?: string;
  /** ATC session callsign from the backend (same as `SessionRecord.callsign`). */
  callsign?: string | null;
  status?: string;
  pilotUserId?: string;
  assignedTowerUserId?: string | null;
  towerPresent?: boolean;
  messageCount?: number;
  lastMessageAt?: string | null;
  updatedAt: string;
};

type LobbyRoomsRes = { ok?: boolean; rooms?: ActivePilotRoom[] };

/**
 * Why the controller's telemetry view isn't currently being updated. Mirrors the
 * backend's `TelemetryHealthState`. `live` = stream is healthy; `stale` = derived
 * server-side when the plugin stops posting without a goodbye (KSP CTD, network
 * drop). Everything else is an explicit "going dark" reason pushed by the plugin.
 */
type TelemetryHealthState =
  | "live"
  | "beacon_off"
  | "paused"
  | "scene_left"
  | "warp"
  | "vessel_dead"
  | "vessel_switch"
  | "stale";

type TelemetryHealth = {
  state: TelemetryHealthState;
  ageSeconds: number | null;
  lastTelemetryAt: string | null;
  /** Plugin-supplied event when `state` is one of the explicit going-dark values. */
  reason?: { state: Exclude<TelemetryHealthState, "live" | "stale">; at: string; message?: string };
  staleThresholdSeconds: number;
};

type SessionRes = {
  ok?: boolean;
  session?: {
    id: string;
    pilotUserId?: string;
    assignedTowerUserId?: string;
    callsign?: string;
    squawk?: string;
    status?: string;
    telemetry?: Telemetry | null;
    updatedAt?: string;
    lastTelemetryAt?: string | null;
    countdownStartsAt?: string;
    countdownLengthSec?: number;
    countdownRequest?: { at: string; byUserId: string; label?: string };
    takeoffRequest?: { at: string; byUserId: string; label?: string };
    clearances?: SessionClearances;
    expectedLandingRunway?: string;
    phaseTimeline?: Array<{ code: string; at: string }>;
    recentViolations?: Array<{ id: string; kind: string; at: string; detail?: string }>;
    radioState?: {
      busy: boolean;
      blocked: boolean;
      freqMhz?: number;
      transmitterSessionId?: string;
      transmitterCallsign?: string;
      blockedBySessionId?: string;
      blockedByCallsign?: string;
      blockedWithSessionId?: string;
      blockedWithCallsign?: string;
      message?: string;
    };
    lastLandingQuality?: "GOOD" | "HARD" | "OFF_CENTER";
    stagingMoveRequest?: { preset: string; label: string; issuedAt: string; issuedByUserId: string };
  };
  telemetryCadenceSeconds?: number;
  telemetryHealth?: TelemetryHealth;
};

function formatAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Human-readable label for the telemetry health banner. Combines the reason
 * (beacon off / paused / scene left / vessel switch / warp / stale) with how long
 * ago the last sample
 * arrived so the controller can tell "just paused" from "completely gone".
 */
function telemetryHealthLabel(h: TelemetryHealth | null | undefined): {
  title: string;
  detail: string;
  tone: "warn" | "alert";
} | null {
  if (!h || h.state === "live") return null;
  const ageBit =
    h.ageSeconds == null
      ? "no telemetry yet"
      : h.ageSeconds < 60
        ? `last sample ${h.ageSeconds}s ago`
        : h.ageSeconds < 3600
          ? `last sample ${Math.floor(h.ageSeconds / 60)}m ago`
          : `last sample ${Math.floor(h.ageSeconds / 3600)}h ago`;
  switch (h.state) {
    case "beacon_off":
      return {
        title: "BEACON OFF",
        detail: `Pilot disabled telemetry beacon · ${ageBit}`,
        tone: "warn"
      };
    case "scene_left":
      return {
        title: "PILOT NOT IN FLIGHT",
        detail: `Pilot left the flight scene (revert / recover / Space Center / quit) · ${ageBit}`,
        tone: "warn"
      };
    case "vessel_switch":
      return {
        title: "VESSEL SWITCH",
        detail: `${h.reason?.message ?? "Pilot switched active vessel"} · ${ageBit}`,
        tone: "warn"
      };
    case "paused":
      return {
        title: "GAME PAUSED",
        detail: `Simulation is paused (ESC / pause menu) · ${ageBit}`,
        tone: "warn"
      };
    case "warp":
      return {
        title: "TIME WARP",
        detail: `${h.reason?.message ?? "On-rails time warp"} — live values paused · ${ageBit}`,
        tone: "warn"
      };
    case "vessel_dead":
      return {
        title: "VESSEL LOST",
        detail: `Active vessel destroyed (crash / explode / break-up) · ${ageBit}`,
        tone: "alert"
      };
    case "stale":
      return {
        title: "NO SIGNAL",
        detail: `No telemetry for ${ageBit.replace("last sample ", "")} — pilot may have crashed, disconnected, or lost network.`,
        tone: "alert"
      };
    default:
      return null;
  }
}

/**
 * Small ASCEND/DESCEND chip shown next to the V/H speed row. Hovers over 0.5 m/s vertical speed
 * trip in/out of the chip so the badge does not flicker on tiny noise. Border turns danger-red
 * whenever the airframe pulls more than 9 g, regardless of climb direction.
 */

const VS_CLIMB_THRESHOLD_MS = 0.5;
const G_LOAD_DANGER_THRESHOLD = 9;
function VerticalTrendBadge({
  verticalSpeed,
  gLoad
}: {
  verticalSpeed?: number;
  gLoad?: number;
}): JSX.Element | null {
  if (verticalSpeed == null || !Number.isFinite(verticalSpeed)) return null;
  const ascending = verticalSpeed > VS_CLIMB_THRESHOLD_MS;
  const descending = verticalSpeed < -VS_CLIMB_THRESHOLD_MS;
  if (!ascending && !descending) return null;
  const overG = gLoad != null && Number.isFinite(gLoad) && Math.abs(gLoad) > G_LOAD_DANGER_THRESHOLD;
  const cls = [
    "tower-vs-badge",
    ascending ? "tower-vs-badge-asc" : "tower-vs-badge-desc",
    overG ? "tower-vs-badge-overg" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={cls}
      title={overG ? `Over ${G_LOAD_DANGER_THRESHOLD} G — airframe stress warning` : undefined}
    >
      {ascending ? "ASCEND" : "DESCEND"}
    </span>
  );
}


type TowerDeskProps = {
  initialSessionId?: string;
  fallbackSessionId?: string;
  /** Passed through to TowerWall (booth slot hidden for pilots). Default true. */
  showBooth?: boolean;
  /** Optional left cluster before room/callsign/squawk on the wall session strip. */
  wallSessionStripLeading?: ReactNode;
  /** Optional controls before “Wall layout” on the session strip (e.g. Quit tower). */
  wallSessionStripTrailing?: ReactNode;
  /** Passed through to TowerWall for strip border / tone. */
  wallSessionStripEmphasis?: SessionStripEmphasis;
};

export function TowerDesk({
  initialSessionId,
  fallbackSessionId,
  showBooth,
  wallSessionStripLeading,
  wallSessionStripTrailing,
  wallSessionStripEmphasis
}: TowerDeskProps = {}): JSX.Element {
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState(false);
  // No `dev-shared` fallback: the parent /tower route is gated on the server
  // returning a real active room (see App.tsx `activeRoomOnly`), so reaching
  // this component implies a real session id. If the prop is empty we render
  // an empty-state card below instead of silently latching onto the bootstrap
  // session.
  const [sessionId, setSessionId] = useState(initialSessionId?.trim() ?? "");
  const [nowTick, setNowTick] = useState(() => Date.now());
  const qc = useQueryClient();
  const liveConnected = useTowerLiveSubscriptions(sessionId);

  // Session detail (telemetry + health) — polled every 1 s by TanStack Query.
  // The desk used to setState in a manual interval; using a query gets us
  // automatic dedup (other panels asking for the same session detail share
  // this single HTTP call), background refetch on focus, and a uniform error
  // shape we can branch on.
  const sessionQuery = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });

  // Auto-failover: if the operator passed an `initialSessionId` AND a different
  // `fallbackSessionId`, and the initial one has no telemetry yet, swap the
  // active session id to the fallback so the desk shows live data instead of
  // an empty pane. Once swapped, the user's "Track" buttons override this.
  useEffect(() => {
    const initialId = initialSessionId?.trim();
    const fallbackId = fallbackSessionId?.trim();
    if (!initialId || !fallbackId || initialId === fallbackId) return;
    if (sessionId !== initialId) return;
    if (!sessionQuery.data) return;
    if (sessionQuery.data.session?.telemetry == null) {
      setSessionId(fallbackId);
    }
  }, [sessionQuery.data, initialSessionId, fallbackSessionId, sessionId]);

  const telemetry = sessionQuery.data?.session?.telemetry ?? null;
  const telemetryHealth = sessionQuery.data?.telemetryHealth ?? null;
  const radioState = sessionQuery.data?.session?.radioState;

  const sessionMeta = (() => {
    if (!sessionQuery.data) return "";
    const s = sessionQuery.data.session;
    if (!s) return "";
    if (
      initialSessionId?.trim() &&
      fallbackSessionId?.trim() &&
      initialSessionId !== fallbackSessionId &&
      sessionId === fallbackSessionId
    ) {
      return `No telemetry in ${initialSessionId} yet. Showing telemetry session ${fallbackSessionId}.`;
    }
    return `Session ${s.id ?? sessionId} · pilot ${s.pilotUserId ?? "—"} · updated ${s.updatedAt ?? "—"}`;
  })();

  const apiTelemetryOffline =
    sessionQuery.error?.unreachable ? sessionQuery.error.message : null;

  // Active pilots / lobby rooms list — only polled when the desk is the
  // standalone /tower view (not when embedded in the unified workspace, where
  // LobbyPage owns this query). The shared cache means even when both are
  // mounted there's only one HTTP call.
  const embedded = !!initialSessionId;
  const activePilotsQuery = useApiQuery<LobbyRoomsRes>({
    queryKey: queryKeys.lobby.rooms,
    path: "/v1/lobby/rooms",
    enabled: !embedded,
    refetchInterval: !embedded ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const activePilots = activePilotsQuery.data?.rooms ?? [];
  const activePilotsErr = activePilotsQuery.error
    ? activePilotsQuery.error.unreachable
      ? "Tower API unreachable."
      : activePilotsQuery.error.message
    : null;

  // Room-wide live aircraft roster. Backend's `/v1/tower/active-aircraft` returns every other
  // pilot whose telemetry has fired in the last ~30 s (the requester's own session is excluded
  // server-side), with whatever orbital fields the publisher has on the wire. We poll at 3 s
  // because orbits don't change visibly faster than that and a packed lobby (10+ pilots) at 1 s
  // would be wasteful. Strictly additive — failure of this query doesn't block the page; the
  // schematic just falls back to "self only" until it recovers.
  type ActiveAircraftRes = {
    ok?: boolean;
    aircraft?: ActiveAircraftWire[];
    separationConflicts?: Array<{
      sessionA: string;
      sessionB: string;
      callsignA?: string;
      callsignB?: string;
    }>;
    runwayOccupancy?: Array<{
      key: string;
      bodyName: string;
      runwayId: string;
      record: { occupied: boolean; bySessionId?: string; sinceMs?: number; lastLandingAtMs?: number };
    }>;
  };
  const activeAircraftQuery = useApiQuery<ActiveAircraftRes>({
    queryKey: queryKeys.tower.activeAircraft(),
    path: "/v1/tower/active-aircraft",
    refetchInterval: liveConnected ? false : 3_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const activeAircraft = activeAircraftQuery.data?.aircraft ?? [];
  const separationConflicts = activeAircraftQuery.data?.separationConflicts ?? [];
  const runwayOccupancy = activeAircraftQuery.data?.runwayOccupancy ?? [];

  // World inventory — published once per game session at SC entry, slow-poll
  // every 60 s so a planet-pack swap eventually catches up. Cached on a
  // session-scoped key so opening the same session in another tab is free.
  const worldInventoryQuery = useApiQuery<WorldInventory | null>({
    queryKey: queryKeys.world.inventory(sessionId),
    queryFn: () => fetchWorldInventory(sessionId.trim()),
    enabled: !!sessionId.trim(),
    refetchInterval: sessionId.trim() ? 60_000 : false,
    staleTime: 30_000,
    placeholderData: (prev) => prev
  });
  const worldInventory = worldInventoryQuery.data ?? null;

  const handOffMutation = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId.trim())}/next-tower`, {
        method: "POST",
        body: "{}"
      }),
    onSuccess: () => {
      setErr(false);
      setMsg("Handed off to the next tower operator.");
      void qc.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
      void qc.invalidateQueries({ queryKey: queryKeys.lobby.rooms });
    },
    onError: (e) => {
      setErr(true);
      setMsg(`${e.message}\n\n${JSON.stringify(e.body, null, 2)}`);
    }
  });
  const handOffBusy = handOffMutation.isPending;
  const handOff = (): void => {
    if (!sessionId.trim()) return;
    handOffMutation.mutate();
  };

  // Live world data (planet pack, KK sites, RSS, …) merged on top of the bundled stock-Kerbin
  // defaults. When the plugin has never published, all of these collapse to the stock values so
  // the page is fully usable on a vanilla install with no plugin running.
  const effectiveNavaids = useMemo<readonly KerbinNavAid[]>(
    () => (worldInventory ? navaidsForHomeBody(worldInventory) : KERBIN_NAVAIDS),
    [worldInventory]
  );
  const effectiveLaunchSites = useMemo<readonly KerbinLaunchSite[]>(
    () => (worldInventory ? launchSitesForHomeBody(worldInventory) : KERBIN_LAUNCH_SITES),
    [worldInventory]
  );
  const effectiveRadiusM = worldInventory?.home.radiusM ?? KERBIN_RADIUS_M;
  const homeBodyName = worldInventory?.home.name ?? "Kerbin";

  const towerAircraftTracks = useMemo(
    () =>
      buildTowerAircraftTracks({
        homeBodyName,
        sessionId: sessionId.trim(),
        telemetry,
        selfCallsign: sessionQuery.data?.session?.callsign,
        active: activeAircraft
      }),
    [homeBodyName, sessionId, telemetry, sessionQuery.data?.session?.callsign, activeAircraft]
  );

  // System catalog (stock-Kerbol / RSS / JNSQ / OPM) — drives the body picker, system schematic,
  // and per-body BodyMap render. `kind: "missing"` means the player's planet pack isn't bundled
  // and we render exactly the legacy single-home-body UI (no schematic / picker / off-world panel).
  // See `web/src/data/systemCatalog.ts` and `useSystemCatalog`.
  //
  // Fallback: when the KSP plugin hasn't published `/v1/world-inventory/{sessionId}` yet (fresh
  // session, plugin not installed, backend 404), we still want the *schematic* to render so the
  // operator has something on screen instead of a blank panel. Default to `kerbin-stock` — same
  // convention `MapBodyDropdown` uses. Vessel placement still requires real inventory, so this
  // fallback is decorative; once live inventory arrives the real worldId takes over.
  const FALLBACK_WORLD_ID = "kerbin-stock";
  const systemCatalogState = useSystemCatalog(worldInventory?.worldId ?? FALLBACK_WORLD_ID);
  const systemCatalog = systemCatalogState.kind === "ready" ? systemCatalogState.catalog : null;

  /**
   * Currently focused body for the BodyMap. Defaults to (and resets on) the home body. When the
   * controller picks a non-home body via the picker / schematic / off-world panel, the inline
   * legacy map is replaced with a BodyMap render of that body. Keeping this null means "use the
   * home body" — explicit null avoids a render flicker before `homeBodyName` resolves.
   */
  const [focusedBodyName, setFocusedBodyName] = useState<string | null>(null);
  const effectiveFocusedBody = focusedBodyName ?? homeBodyName;
  const focusedIsHome = effectiveFocusedBody.toLowerCase() === homeBodyName.toLowerCase();
  const bodyMapNavaids = useMemo(
    () =>
      worldInventory
        ? navaidsForBody(worldInventory, effectiveFocusedBody)
        : effectiveFocusedBody.toLowerCase() === "kerbin"
          ? KERBIN_NAVAIDS
          : [],
    [worldInventory, effectiveFocusedBody]
  );
  const bodyMapLaunchSites = useMemo(
    () =>
      worldInventory
        ? launchSitesForBody(worldInventory, effectiveFocusedBody)
        : effectiveFocusedBody.toLowerCase() === "kerbin"
          ? KERBIN_LAUNCH_SITES
          : [],
    [worldInventory, effectiveFocusedBody]
  );
  // Auto-snap focus back to home if a different home body publishes (e.g. swapping planet packs).
  useEffect(() => {
    if (focusedBodyName && focusedBodyName.toLowerCase() === homeBodyName.toLowerCase()) {
      setFocusedBodyName(null);
    }
  }, [focusedBodyName, homeBodyName]);
  // Pick a "home base" point: prefer the MAS CENTER navaid (KST), then any navaid named CENTER,
  // then the first launch site, then (0, 0). RSS / JNSQ players don't have a "KSC" — for them this
  // resolves to whichever runway is closest to their actual main base on the active body.
  const { homeBaseLat, homeBaseLon } = useMemo<{ homeBaseLat: number; homeBaseLon: number }>(() => {
    const center =
      effectiveNavaids.find((n) => n.id === "KST") ??
      effectiveNavaids.find((n) => n.name.toUpperCase() === "CENTER");
    if (center) return { homeBaseLat: center.lat, homeBaseLon: center.lon };
    const firstSite = effectiveLaunchSites[0];
    if (firstSite) return { homeBaseLat: firstSite.lat, homeBaseLon: firstSite.lon };
    return { homeBaseLat: KSC_LAT, homeBaseLon: KSC_LON };
  }, [effectiveNavaids, effectiveLaunchSites]);


  // Re-seed sessionId when the parent prop changes (e.g. user navigates from
  // /lobby with a different room). Clear when the prop clears so we don't keep
  // polling a stale id (same-tab storage can race the route guard by a frame).
  useEffect(() => {
    setSessionId(initialSessionId?.trim() ?? "");
  }, [initialSessionId]);

  // Pure clock tick — drives the "Updated 13s ago" labels between data
  // refetches. Intentionally not a TanStack query: it's just a wall-clock,
  // there's nothing to fetch.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);




  // World inventory is now sourced from the TanStack `worldInventoryQuery`
  // above — replaces the old 60s setInterval poller.

  const hasCoords = telemetry?.lat != null && telemetry?.lon != null;
  const onHomeBody = telemetry?.bodyName?.toLowerCase() === homeBodyName.toLowerCase();
  // Suppress the KSC-distance readout when the vessel isn't actually on the home body — the great
  // circle math uses the home radius and home base coords, so reporting a "distance to KSC" while
  // the ship is on Mun is misleading at best. Latent bug fixed as part of the multi-body rollout.
  const kscDistanceM =
    hasCoords && telemetry && onHomeBody
      ? kerbinDistanceMeters(
          telemetry.lat as number,
          telemetry.lon as number,
          homeBaseLat,
          homeBaseLon,
          effectiveRadiusM
        )
      : null;

  const nearKsc = kscDistanceM != null ? kscDistanceM <= NEAR_KSC_M : false;
  const kscDistanceLabel =
    kscDistanceM == null ? "—" : kscDistanceM >= 1000 ? `${(kscDistanceM / 1000).toFixed(1)} km` : `${Math.round(kscDistanceM)} m`;

  // System-wide vessel projection. We merge the focused session's own telemetry (full fidelity,
  // 1 Hz) with the lighter room-wide active-aircraft roster (3 s) so the schematic, off-world
  // panel, and per-body counts all reflect every live ship in the lobby — not just the one
  // the controller is staring at. Self is keyed by `sessionId` and skipped from the roster
  // merge to avoid double-counting (the backend already excludes the requester, so this is
  // belt-and-braces in case the same player ever appears under both shapes).
  const selfId = sessionId || "self";

  const vesselCounts = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    const bump = (body: string | undefined): void => {
      if (!body) return;
      m.set(body, (m.get(body) ?? 0) + 1);
    };
    bump(telemetry?.bodyName);
    for (const a of activeAircraft) {
      if (a.sessionId === selfId) continue;
      bump(a.bodyName);
    }
    return m;
  }, [telemetry?.bodyName, activeAircraft, selfId]);

  // Orbit specs for the schematic. Restrict to ORBITING because the publisher emits Ap/Pe
  // whenever `!LandedOrSplashed`, which includes sub-orbital ballistic flights and hyperbolic
  // escapes — both of those would draw misleading "orbits" through the ground or off-canvas,
  // so skip them until we have full Keplerian elements on the wire.
  const vesselOrbits = useMemo<Map<string, VesselOrbitSpec[]>>(() => {
    const m = new Map<string, VesselOrbitSpec[]>();
    const push = (spec: VesselOrbitSpec): void => {
      const key = spec.bodyName.toLowerCase();
      const arr = m.get(key);
      if (arr) arr.push(spec);
      else m.set(key, [spec]);
    };

    if (
      telemetry?.bodyName &&
      telemetry.situation === "ORBITING" &&
      telemetry.apoapsis != null &&
      telemetry.periapsis != null &&
      telemetry.apoapsis > 0 &&
      telemetry.periapsis >= 0
    ) {
      push({
        id: selfId,
        bodyName: telemetry.bodyName,
        apoapsisM: telemetry.apoapsis,
        periapsisM: telemetry.periapsis,
        callsign: aircraftPrimaryLabel(telemetry),
        isSelf: true
      });
    }

    for (const a of activeAircraft) {
      if (a.sessionId === selfId) continue;
      if (
        !a.bodyName ||
        a.situation !== "ORBITING" ||
        a.apoapsis == null ||
        a.periapsis == null ||
        !(a.apoapsis > 0) ||
        !(a.periapsis >= 0)
      ) {
        continue;
      }
      push({
        id: a.sessionId,
        bodyName: a.bodyName,
        apoapsisM: a.apoapsis,
        periapsisM: a.periapsis,
        callsign: a.callsign ?? a.craftName ?? a.pilotName ?? undefined,
        isSelf: false
      });
    }

    return m;
  }, [telemetry, activeAircraft, selfId]);

  const offWorldVessels = useMemo<OffWorldVessel[]>(() => {
    const focusedLower = effectiveFocusedBody.toLowerCase();
    const out: OffWorldVessel[] = [];

    if (telemetry?.bodyName && telemetry.bodyName.toLowerCase() !== focusedLower) {
      out.push({
        id: selfId,
        callsign: aircraftPrimaryLabel(telemetry),
        bodyName: telemetry.bodyName,
        situation: telemetry.situation,
        radarAltM: telemetry.radarAlt,
        aslAltM: telemetry.aslAlt,
        apoapsisM: telemetry.apoapsis,
        periapsisM: telemetry.periapsis,
        biome: telemetry.biome,
        isSelf: true
      });
    }

    for (const a of activeAircraft) {
      if (a.sessionId === selfId) continue;
      if (!a.bodyName || a.bodyName.toLowerCase() === focusedLower) continue;
      out.push({
        id: a.sessionId,
        callsign: a.callsign ?? a.craftName ?? a.pilotName ?? "Unknown craft",
        bodyName: a.bodyName,
        situation: a.situation,
        apoapsisM: a.apoapsis,
        periapsisM: a.periapsis,
        isSelf: false
      });
    }

    return out;
  }, [telemetry, activeAircraft, selfId, effectiveFocusedBody]);

  // Vessels currently on the focused body — drives the BodyMap dot layer when off-home is focused.
  const focusedBodyVessels = useMemo<BodyMapVessel[]>(() => {
    if (!telemetry?.bodyName || telemetry.lat == null || telemetry.lon == null) return [];
    if (telemetry.bodyName.toLowerCase() !== effectiveFocusedBody.toLowerCase()) return [];
    const plotLat =
      telemetry.smoothedPositionValid && telemetry.smoothedLat != null ? telemetry.smoothedLat : telemetry.lat;
    const plotLon =
      telemetry.smoothedPositionValid && telemetry.smoothedLon != null ? telemetry.smoothedLon : telemetry.lon;
    return [
      {
        id: sessionId || "self",
        label: aircraftPrimaryLabel(telemetry),
        lat: plotLat,
        lon: plotLon,
        situation: telemetry.situation,
        isSelf: true
      }
    ];
  }, [telemetry, sessionId, effectiveFocusedBody]);

  const focusedBodyDescriptor = useMemo(() => {
    if (!systemCatalog) return null;
    const target = effectiveFocusedBody.toLowerCase();
    return systemCatalog.bodies.find((b) => b.name.toLowerCase() === target) ?? null;
  }, [systemCatalog, effectiveFocusedBody]);

  const sortedActivePilots = [...activePilots].sort((a, b) => {
    const ta = Date.parse(a.lastMessageAt ?? a.updatedAt ?? "") || 0;
    const tb = Date.parse(b.lastMessageAt ?? b.updatedAt ?? "") || 0;
    return tb - ta;
  });


  const telemetryTable = telemetry ? (
    <table className="tower-telemetry-table">
      <tbody>
        <tr>
          <td title={CALLSIGN_DISPLAY_HELP}>Callsign</td>
          <td className="atc-session-callsign" title={CALLSIGN_DISPLAY_HELP}>
            {sessionQuery.data?.session?.callsign?.trim() ||
              telemetry.callsign?.trim() ||
              "—"}
          </td>
        </tr>
        <tr><td>Ship</td><td>{telemetry.craftName ?? "—"}</td></tr>
        <tr><td>Pilot</td><td>{telemetry.pilotName ?? "—"}</td></tr>
        <tr><td>Type</td><td>{telemetry.craftType ?? "—"}</td></tr>
        <tr><td>Body / situation</td><td>{telemetry.bodyName ?? "—"} · {telemetry.situation ?? "—"}</td></tr>
        <tr><td>Biome</td><td>{telemetry.biome && telemetry.biome.length > 0 ? telemetry.biome : "—"}</td></tr>
        <tr><td>UT</td><td>{telemetry.universalTime != null ? telemetry.universalTime.toFixed(1) : "—"}</td></tr>
        <tr>
          <td>Lat / lon</td>
          <td>
            {formatNum(telemetry.lat, 4)}° / {formatNum(telemetry.lon, 4)}°
            {telemetry.smoothedPositionValid &&
            telemetry.smoothedLat != null &&
            telemetry.smoothedLon != null ? (
              <>
                {" "}
                <span className="tower-muted" title="Smoothed for map / ghosts">
                  (smoothed {formatNum(telemetry.smoothedLat, 4)}° / {formatNum(telemetry.smoothedLon, 4)}°)
                </span>
              </>
            ) : null}
          </td>
        </tr>
        <tr><td>Radar / ASL</td><td>{formatNum(telemetry.radarAlt, 0)} m / {formatNum(telemetry.aslAlt, 0)} m</td></tr>
        <tr>
          <td>Speed V / H</td>
          <td>
            <VerticalTrendBadge verticalSpeed={telemetry.verticalSpeed} gLoad={telemetry.gLoad} />
            {formatNum(telemetry.verticalSpeed, 1)} m/s vert · {formatNum(telemetry.surfaceSpeed, 1)} m/s surf
          </td>
        </tr>
        <tr><td>Heading / AoA</td><td>{formatNum(telemetry.heading, 1)}° · {formatNum(telemetry.aoa, 1)}°</td></tr>
        <tr><td>Throttle / G</td><td>{(telemetry.throttle != null ? (telemetry.throttle * 100).toFixed(0) : "—")}% · {formatNum(telemetry.gLoad, 2)} G</td></tr>
        <tr><td>Ap / Pe</td><td>{telemetry.apoapsis != null ? `${formatNum(telemetry.apoapsis, 0)} m` : "—"} / {telemetry.periapsis != null ? `${formatNum(telemetry.periapsis, 0)} m` : "—"}</td></tr>
        <tr><td>Mass wet / dry</td><td>{formatMassTons(telemetry.wetMass)} / {formatMassTons(telemetry.dryMass)}</td></tr>
        <tr>
          <td>Crew</td>
          <td>
            {formatCrew(telemetry)}
            {/*
              Phase 4 (KERBALISM_TELEMETRY_PLAN.md): when the plugin sent the
              richer `crewStats` array, render trait + level + Kerbalism dose
              per kerbal. Falls back to the comma-joined `crewNames` for older
              plugin builds so the row never blank-flashes mid-upgrade.
            */}
            {telemetry.crewStats && telemetry.crewStats.length > 0 ? (
              <ul className="tower-telemetry-crewlist tower-crew-stats">
                {telemetry.crewStats.map((c, i) => {
                  const dose = telemetry.kerbalism?.crew?.find((k) => k.name === c.name)?.doseRad;
                  return (
                    <li key={`${c.name}-${i}`} className="tower-crew-line">
                      <span
                        className={
                          "tower-crew-name" +
                          (c.isVeteran ? " is-veteran" : "") +
                          (c.isBadass ? " is-badass" : "")
                        }
                      >
                        {c.name}
                      </span>
                      <span className="tower-crew-trait">
                        {" · "}
                        {c.trait || c.type} L{c.experienceLevel}
                      </span>
                      <span className="tower-crew-stat" title="Courage / Stupidity">
                        {" · C"}
                        {(c.courage * 100).toFixed(0)}
                        {" S"}
                        {(c.stupidity * 100).toFixed(0)}
                      </span>
                      {dose != null ? (
                        <span className="tower-crew-dose" title="Kerbalism cumulative dose">
                          {" · "}
                          {formatRadiation(dose)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : telemetry.crewNames && telemetry.crewNames.length > 0 ? (
              <div className="tower-telemetry-crewlist">{telemetry.crewNames.join(", ")}</div>
            ) : null}
          </td>
        </tr>
        {telemetry.radiationAvailable ? (
          <tr><td>Radiation</td><td>{formatRadiation(telemetry.radiation)}</td></tr>
        ) : null}
        {/*
          Kerbalism Phase 4: life-support burn-down. One row per resource the
          vessel actually carries (the plugin filters empties). "Days left" is
          home-body days so the controller's reading matches what KSP shows
          the player. Stock saves with no Kerbalism see no rows.
        */}
        {telemetry.kerbalism?.lifeSupport
          ? Object.entries(telemetry.kerbalism.lifeSupport).map(([key, ls]) => (
              <tr key={`ls-${key}`}>
                <td>{LIFE_SUPPORT_LABEL[key] ?? key}</td>
                <td>
                  <span className="tower-ls-days">
                    {formatKerbinDays(ls.daysRemaining, ls.secondsRemaining)}
                  </span>
                  {ls.max > 0 ? (
                    <span className="tower-ls-amount">
                      {" · "}
                      {ls.amount.toFixed(1)} / {ls.max.toFixed(1)}
                    </span>
                  ) : null}
                  {ls.ratePerSec < 0 ? (
                    <span className="tower-ls-rate" title="Net consumption per home-body day">
                      {" · "}
                      {(ls.ratePerSec * 86400).toFixed(2)}/d
                    </span>
                  ) : ls.ratePerSec > 0 ? (
                    <span className="tower-ls-rate is-positive" title="Net production per home-body day">
                      {" · +"}
                      {(ls.ratePerSec * 86400).toFixed(2)}/d
                    </span>
                  ) : null}
                </td>
              </tr>
            ))
          : null}
        {telemetry.kerbalism?.storm?.incoming ? (
          <tr>
            <td>Storm</td>
            <td className="tower-ls-storm">
              INCOMING
              {telemetry.kerbalism.storm.durationSec != null ? (
                <>
                  {" · "}
                  {formatKerbinDays(
                    telemetry.kerbalism.storm.durationSec / (HOME_DAY_SECONDS_FALLBACK),
                    telemetry.kerbalism.storm.durationSec
                  )}{" "}
                  expected
                </>
              ) : null}
            </td>
          </tr>
        ) : null}
        <tr>
          <td>Comms</td>
          <td>
            <span className={`tower-comms-chip tower-comms-chip-${commsStatus(telemetry)}`}>
              {commsStatusLabel(commsStatus(telemetry), telemetry.commSignal)}
            </span>
          </td>
        </tr>
        <tr><td>Gear / brakes / lights</td><td>{formatBool(telemetry.gearDown)} / {formatBool(telemetry.brakes)} / {formatBool(telemetry.lights)}</td></tr>
        {telemetry.far?.available ? (
          <tr>
            <td>FAR</td>
            <td>
              Flaps {formatFarFlapSetting(telemetry.far.flap)}
              {" · "}
              Spoiler {telemetry.far.spoiler ? "deployed" : "retracted"}
            </td>
          </tr>
        ) : null}
        <tr><td>RCS / SAS</td><td>{formatBool(telemetry.rcs)} / {formatBool(telemetry.sas)}</td></tr>
        {telemetry.targetRunway ? (
          <tr><td>Runway</td><td>{telemetry.targetRunway}</td></tr>
        ) : null}
        {telemetry.distKSC != null && telemetry.distKSC > 10 ? (
          <tr>
            <td>KSC sector</td>
            <td>
              {telemetry.kscAerodrome ?? "—"} · {Math.round(telemetry.distKSC)} m · brg{" "}
              {telemetry.bearingKSC != null ? `${Math.round(telemetry.bearingKSC)}°` : "—"}
              {telemetry.activeRunway ? ` · RWY ${telemetry.activeRunway}` : ""}
              {telemetry.alignErr != null ? ` · Δ${telemetry.alignErr.toFixed(0)}°` : ""}
            </td>
          </tr>
        ) : null}
        {telemetry.onApproach ||
        telemetry.landing ||
        (telemetry.flightPhase && telemetry.flightPhase !== "CRUISE") ||
        (telemetry.touchdownEtaSec != null && telemetry.touchdownEtaSec > 0) ? (
          <tr>
            <td>Phase / approach</td>
            <td>
              {telemetry.flightPhase ?? "—"}
              {telemetry.onApproach ? " · on approach" : ""}
              {telemetry.landing ? " · landing" : ""}
              {telemetry.touchdownEtaSec != null && telemetry.touchdownEtaSec > 0
                ? ` · TD ~${telemetry.touchdownEtaSec.toFixed(0)} s`
                : ""}
            </td>
          </tr>
        ) : null}
        {telemetry.radioFreqMhz != null || telemetry.radioPtt != null || radioState ? (
          <tr>
            <td>Radio snapshot</td>
            <td>
              {telemetry.radioFreqMhz != null ? `${displayMhzFromNumber(telemetry.radioFreqMhz)} MHz` : "—"}
              {telemetry.radioPtt != null ? ` · PTT ${telemetry.radioPtt ? "TX" : "RX"}` : ""}
              {radioState?.busy ? " · FREQ BUSY" : ""}
              {radioState?.blocked ? ` · ${radioState.message ?? "BLOCKED - SAY AGAIN"}` : ""}
              {radioState?.transmitterCallsign ? ` · speaker ${radioState.transmitterCallsign}` : ""}
            </td>
          </tr>
        ) : null}
        {telemetry.fuelLow ? (
          <tr>
            <td>Fuel</td>
            <td className="tower-ls-storm">LOW</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  ) : null;

  const me = useMemo(() => getStoredUser(), []);
  const trackedRoom = useMemo(
    () => activePilots.find((r) => r.roomId === sessionId.trim()) ?? null,
    [activePilots, sessionId]
  );
  const pilotLabel = trackedRoom?.pilotUserId ?? telemetry?.pilotName ?? "—";
  const operatorId = trackedRoom?.assignedTowerUserId ?? null;
  const operatorIsMe = !!(me && operatorId && operatorId === me.id);
  const operatorLabel = operatorId
    ? operatorId
    : trackedRoom?.towerPresent
      ? "Controller online"
      : "Unattended";
  const operatorTone = operatorId
    ? operatorIsMe
      ? "is-me"
      : "is-other"
    : trackedRoom?.towerPresent
      ? "is-other"
      : "is-empty";
  const updatedSrc = trackedRoom?.lastMessageAt ?? trackedRoom?.updatedAt ?? null;
  const updatedLabel = updatedSrc ? formatAge(updatedSrc, nowTick) : "—";
  const countdownRequest = sessionQuery.data?.session?.countdownRequest;
  const takeoffRequest = sessionQuery.data?.session?.takeoffRequest;
  const countdownRequestAge = countdownRequest ? formatAge(countdownRequest.at, nowTick) : null;
  const takeoffRequestAge = takeoffRequest ? formatAge(takeoffRequest.at, nowTick) : null;
  const flightStatus = deriveFlightStatusPill({
    telemetry,
    telemetryHealth,
    countdownRequest,
    takeoffRequest
  });

  const towerClearancesCard =
    me && sessionId && userHasCapability(me, "controller:assume") ? (
      <div className="card tower-clearances-stack">
        <div className="card-head">
          <h2>Tower clearances</h2>
        </div>
        <ClearancePanel
          sessionId={sessionId}
          user={me}
          clearances={sessionQuery.data?.session?.clearances}
          expectedLandingRunway={sessionQuery.data?.session?.expectedLandingRunway ?? ""}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
            void qc.invalidateQueries({ queryKey: queryKeys.tower.activeAircraft() });
          }}
        />
      </div>
    ) : null;

  return (
    <>

      {!embedded ? (
        <header className="page-header tower-page-header">
          <div className="tower-header-title">
            <h1>Tower</h1>
            <p>Vessel data from pilots in-game, navaid map, and who is online.</p>
            {sessionMeta ? <p className="tower-header-note">{sessionMeta}</p> : null}
          </div>

          {sessionId ? (
            <div className="tower-header-ops" aria-label="Session ops status">
              <div className="tower-header-ops-cell tower-header-ops-callsign">
                <span className="tower-header-ops-label" title={CALLSIGN_DISPLAY_HELP}>
                  Callsign
                </span>
                <span
                  className="tower-header-ops-value atc-session-callsign"
                  title={CALLSIGN_DISPLAY_HELP}
                >
                  {sessionQuery.data?.session?.callsign?.trim() || "—"}
                </span>
              </div>
              <div className="tower-header-ops-cell">
                <span className="tower-header-ops-label">Session</span>
                <code className="tower-header-ops-value mono">{sessionId}</code>
              </div>
              <div className="tower-header-ops-cell">
                <span className="tower-header-ops-label">Pilot</span>
                <span className="tower-header-ops-value mono">{pilotLabel}</span>
              </div>
              <div className="tower-header-ops-cell">
                <span className="tower-header-ops-label">Tower</span>
                <span className={`tower-header-ops-value mono tower-op ${operatorTone}`}>
                  {operatorLabel}
                </span>
              </div>
              <div className="tower-header-ops-cell">
                <span className="tower-header-ops-label">Updated</span>
                <span className="tower-header-ops-value">{updatedLabel}</span>
              </div>
            </div>
          ) : null}

          {sessionId ? (
            <div className="tower-header-actions">
              <button
                type="button"
                onClick={() => void handOff()}
                disabled={handOffBusy || !sessionId.trim()}
                title="Hand off this session to the next eligible tower operator"
              >
                {handOffBusy ? "Handing off…" : "Hand off tower"}
              </button>
            </div>
          ) : null}
        </header>
      ) : null}

      {apiTelemetryOffline ? (
        <div className="api-offline-inline" role="alert">
          <strong>Cannot reach tower API.</strong> {apiTelemetryOffline} Will keep retrying every second.
        </div>
      ) : null}

      {msg ? (
        <pre className={`msg ${err ? "error" : "ok"}`} style={{ margin: "0 0 0.75rem" }}>{msg}</pre>
      ) : null}

      {/* Customizable monitor wall, mounted at the top of the desk so the operator
          can lay out the feeds they care about (hullcams, telemetry, schematic,
          interactive map, …) without leaving the desk. The standalone /wall route
          mounts the same component with a different persistKey so the desk-inline
          and standalone walls have independent slot map state.

          Intentionally NOT gated on `!embedded` — the canonical /tower route
          (TowerPage.tsx) ALWAYS passes `initialSessionId` (which sets embedded=true)
          to seed the session id from localStorage, so gating on !embedded would hide
          the wall from the very page it's meant to appear on. The gate is just on
          having a session id at all. */}
      {sessionId ? (
        <TowerWall
          sessionId={sessionId}
          persistKey="tower-desk-wall"
          showBoothSlot={showBooth ?? true}
          sessionStripLeading={wallSessionStripLeading}
          sessionStripTrailing={wallSessionStripTrailing}
          sessionStripEmphasis={wallSessionStripEmphasis}
          sessionStrip={
            <SessionHeader
              sessionId={sessionId}
              callsign={sessionQuery.data?.session?.callsign}
              squawk={sessionQuery.data?.session?.squawk}
            />
          }
          onPopOut={() => {
            // Open the standalone wall in a new browser window the operator can
            // drag to a second monitor. We size to ~half a 1080p screen as a
            // sensible default; the user can resize / maximize from there. The
            // window NAME is constant (`ktn-wall`) so repeated clicks focus the
            // existing popup instead of stacking new ones — and we deliberately
            // do NOT pass `noopener` because that flag forces a new window every
            // time and would defeat the named-window reuse we want here. (Same
            // origin, no third-party content → noopener buys us nothing.)
            const popup = window.open(
              "/tower/wall",
              "ktn-wall",
              "popup,width=1280,height=800"
            );
            popup?.focus();
          }}
        />
      ) : null}

      {embedded && towerClearancesCard ? (
        <div
          className="tower-embedded-controller-strip"
          role="region"
          aria-label="Tower clearances"
        >
          {towerClearancesCard}
        </div>
      ) : null}

      {!embedded ? (
      <div className="tower-grid">
        <aside className="tower-side">
          {!embedded ? (
            <div className="card">
              <div className="card-head">
                <h2>Active pilots</h2>
                <span className="chat-meta" aria-live="polite">
                  {sortedActivePilots.length} live · refresh 5s
                </span>
              </div>
              {activePilotsErr ? (
                <p className="msg error" style={{ margin: 0 }}>{activePilotsErr}</p>
              ) : sortedActivePilots.length === 0 ? (
                <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>
                  No active sessions. Pilots appear here once they create a room from the lobby.
                </p>
              ) : (
                <ul className="tower-pilots-list">
                  {sortedActivePilots.map((p) => {
                    const isActive = p.roomId === sessionId.trim();
                    const ageSrc = p.lastMessageAt ?? p.updatedAt;
                    return (
                      <li key={p.roomId} className={"tower-pilot-row" + (isActive ? " active" : "")}>
                        <button
                          type="button"
                          className="tower-pilot-track"
                          onClick={() => setSessionId(p.roomId)}
                          title={`Track session ${p.roomId}`}
                          disabled={isActive}
                        >
                          {isActive ? "Tracking" : "Track"}
                        </button>
                        <div className="tower-pilot-meta">
                          <div className="tower-pilot-name">
                            {p.callsign?.trim() ? (
                              <span className="atc-session-callsign" title={CALLSIGN_DISPLAY_HELP}>
                                {p.callsign.trim()}
                                <span className="tower-muted"> · </span>
                              </span>
                            ) : null}
                            <code>{p.roomName ?? p.roomId}</code>
                          </div>
                          <div className="tower-pilot-sub">
                            pilot {p.pilotUserId ?? "—"} · {formatAge(ageSrc, nowTick)}
                            {p.towerPresent ? " · controller online" : ""}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}


          <div className="card tower-status-card">
            <div className="card-head">
              <h2>Session summary</h2>
            </div>
            <div className="tower-status-grid">
              <div className={`tower-status-pill tone-${flightStatus.tone}`}>{flightStatus.label}</div>
              {takeoffRequest ? (
                <div className="tower-status-row">
                  <span className="tower-status-key">Takeoff</span>
                  <span className="tower-status-value">
                    {takeoffRequest.label ?? "Pilot"} requested clearance {takeoffRequestAge ?? "just now"}
                  </span>
                </div>
              ) : (
                <div className="tower-status-row">
                  <span className="tower-status-key">Takeoff</span>
                  <span className="tower-status-value muted">No takeoff request</span>
                </div>
              )}
              {countdownRequest ? (
                <div className="tower-status-row">
                  <span className="tower-status-key">Countdown</span>
                  <span className="tower-status-value">
                    {countdownRequest.label ?? "Pilot"} requested countdown {countdownRequestAge ?? "just now"}
                  </span>
                </div>
              ) : (
                <div className="tower-status-row">
                  <span className="tower-status-key">Countdown</span>
                  <span className="tower-status-value muted">No active countdown request</span>
                </div>
              )}
              <div className="tower-status-row">
                <span className="tower-status-key">Game link</span>
                <span className="tower-status-value">{deriveGameLinkLabel(telemetryHealth)}</span>
              </div>
            </div>
          </div>

          {me && sessionId ? (
            <div className="card tower-countdown-card">
              <CountdownPanel
                sessionId={sessionId}
                user={me}
                startsAt={sessionQuery.data?.session?.countdownStartsAt}
                lengthSec={sessionQuery.data?.session?.countdownLengthSec ?? 10}
                countdownRequest={sessionQuery.data?.session?.countdownRequest ?? null}
                takeoffRequest={sessionQuery.data?.session?.takeoffRequest ?? null}
                onChanged={() => void qc.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) })}
              />
            </div>
          ) : null}

          {sessionId && separationConflicts.length > 0 ? (
            <div className="card" role="alert">
              <div className="card-head">
                <h2>Separation</h2>
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {separationConflicts.map((c) => (
                  <li key={`${c.sessionA}:${c.sessionB}`}>
                    CONFLICT: {c.callsignA ?? c.sessionA.slice(0, 8)} / {c.callsignB ?? c.sessionB.slice(0, 8)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {runwayOccupancy.some((o) => o.record.occupied) ? (
            <div className="card">
              <div className="card-head">
                <h2>Runway occupancy</h2>
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {runwayOccupancy
                  .filter((o) => o.record.occupied)
                  .map((o) => (
                    <li key={o.key}>
                      RWY {o.runwayId} occupied
                      {o.record.bySessionId ? ` (${o.record.bySessionId.slice(0, 8)}…)` : ""}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {sessionQuery.data?.session?.phaseTimeline?.length ? (
            <div className="card">
              <div className="card-head">
                <h2>Phase timeline</h2>
              </div>
              <ul className="mono" style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
                {sessionQuery.data.session.phaseTimeline.map((e) => (
                  <li key={`${e.code}-${e.at}`}>
                    {e.code}{" "}
                    {new Date(e.at).toISOString().slice(11, 16)}Z
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {towerClearancesCard}

          <div className={`card${commsStatus(telemetry) === "blackout" ? " card-comms-blackout" : ""}`}>
            <div className="card-head">
              <h2>Pilot telemetry</h2>
              <span className="chat-meta" style={{ color: nearKsc ? "var(--ok)" : "var(--muted)" }}>
                KSC {kscDistanceLabel}{nearKsc ? " · near" : ""}
              </span>
            </div>
            {(() => {
              // Re-derive age from lastTelemetryAt + nowTick so the counter ticks up between
              // the 5s session polls instead of looking frozen at the value the server returned.
              const live: TelemetryHealth | null = telemetryHealth
                ? {
                    ...telemetryHealth,
                    ageSeconds: telemetryHealth.lastTelemetryAt
                      ? Math.max(0, Math.floor((nowTick - Date.parse(telemetryHealth.lastTelemetryAt)) / 1000))
                      : telemetryHealth.ageSeconds
                  }
                : null;
              const banner = telemetryHealthLabel(live);
              if (!banner) return null;
              return (
                <p
                  className={`tower-telemetry-health-banner tower-telemetry-health-${live!.state} tone-${banner.tone}`}
                  role="alert"
                >
                  <strong>{banner.title}</strong> — {banner.detail}
                </p>
              );
            })()}
            {commsStatus(telemetry) === "blackout" ? (
              <p className="tower-comms-blackout-banner" role="alert">
                Comms blackout — pilot has lost CommNet link to KSC. Telemetry below may be stale.
              </p>
            ) : null}
            {telemetry ? telemetryTable : (
              <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>
                No telemetry on <code>{sessionId || "—"}</code> yet. Launch a flight in KSP with the plugin installed.
              </p>
            )}
          </div>

          <div className="card">
            <HullCamPanel sessionId={sessionId} />
          </div>

          <div className="card">
            <TowerViewPanel />
          </div>

          <div className="card">
            <VesselSchematicPanel sessionId={sessionId} />
          </div>

          {systemCatalog ? (
            <div className="card">
              <OffWorldTrafficPanel
                vessels={offWorldVessels}
                catalog={systemCatalog}
                onFocusBody={(name) => setFocusedBodyName(name)}
              />
            </div>
          ) : null}
        </aside>

        <section className="tower-main">
          <div className="card tower-map-card">
            {systemCatalog && !focusedIsHome ? (
              <div className="tower-map-focus-toolbar">
                <span>
                  Focused on <strong>{focusedBodyDescriptor?.displayName ?? effectiveFocusedBody}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setFocusedBodyName(null)}
                  title={`Return to ${homeBodyName} home view`}
                >
                  Back to {homeBodyName}
                </button>
              </div>
            ) : null}

            {!focusedIsHome && systemCatalog ? (
              <BodyMap
                bodyName={effectiveFocusedBody}
                bodyDisplayName={focusedBodyDescriptor?.displayName}
                parentBodyName={focusedBodyDescriptor?.parent ?? null}
                basemapUrl={basemapUrlFor(systemCatalog.worldId, effectiveFocusedBody)}
                vessels={focusedBodyVessels}
                navaids={bodyMapNavaids}
                launchSites={bodyMapLaunchSites}
              />
            ) : (
              <KerbinTowerMap
                sessionId={sessionId}
                telemetry={telemetry}
                towerAircraft={towerAircraftTracks}
                worldInventory={worldInventory}
                systemCatalog={systemCatalog}
                persistKey="tower-desk"
                vesselCounts={vesselCounts}
                onPickFocus={(name) => setFocusedBodyName(name)}
              />
            )}
          </div>

          {systemCatalog ? (
            <div className="card tower-system-overview-card">
              <SystemSchematic
                catalog={systemCatalog}
                vesselCounts={vesselCounts}
                vesselOrbits={vesselOrbits}
                focusedBodyName={effectiveFocusedBody}
                onFocusBody={(name) => setFocusedBodyName(name)}
              />
            </div>
          ) : null}

          {/* kOS terminal mirror lives in the wide column, not the narrow side
            * column, so that the resize handle on its viewport actually has
            * room to grow into. The 360px hard cap on .tower-side made
            * resize:both pointless — drag bigger and it'd overflow the column. */}
          <div className="card tower-kos-screen-card">
            <KosScreenPanel sessionId={sessionId} />
          </div>
        </section>
      </div>
      ) : null}
    </>
  );
}
