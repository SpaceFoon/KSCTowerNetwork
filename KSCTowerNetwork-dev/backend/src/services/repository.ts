import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mariadb";
import { env } from "../config/env";
import { RADIO_QUICK_PRESETS, type RadioQuickPreset } from "../config/radioPresets";
import { getDbPool, isDbAvailable } from "../lib/db";
import { logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { publishLiveSnapshotEvent } from "../live/liveSnapshotBus";
import type { ClearanceKind, SessionClearances } from "../tower/clearanceTypes";
import { updateRadioStateForTelemetry, type RadioState } from "../tower/radioState";
import type { StagingMoveRequest } from "../tower/stagingMoveTypes";
import type { ViolationEvent } from "../tower/violations";
import { listConfiguredWebUsers } from "./webAuth";
import { setRegisteredUserDisplayName } from "./registeredUsers";
import { bridgeDisplayName, isBridgeIdentity, listBridgeIdentities } from "./livekit";

/**
 * Thrown by getUserAccess() when an authenticated subject has no role anywhere
 * — not in the in-memory map, not in the DB. We deliberately do NOT default
 * to `pilot` because that's how operators end up staring at the wrong UI for
 * an hour wondering what's broken. Surface the gap.
 */
export class MissingUserRoleError extends Error {
  constructor(public readonly userId: string) {
    super(
      `No role assigned for userId='${userId}'. Authentication accepted the subject but no setUserRole / ensureUser / startup seed ran. ` +
        `If this is a configured web user, restart the backend so the seed runs; if it's a Clerk subject, ensureUser() should have inserted them.`
    );
    this.name = "MissingUserRoleError";
  }
}

export type Role = "guest" | "pilot" | "controller" | "mod" | "supermod" | "owner";
export type SessionStatus = "queued" | "assigned" | "active" | "closed";

/**
 * Action-level permissions. The hierarchy in `ROLE_RANK` decides which roles get which caps;
 * frontend reads the resolved set from /v1/auth/me so the UI never has to know the rules.
 */
export type Capability =
  | "chat:lobby"
  | "chat:session"
  | "chat:dm"
  // Booth = the spectator-only commentary channel (text + voice) that runs in
  // parallel to the ops channel for a session. Pilot is intentionally excluded
  // (so spectators can chatter without distracting the player); the assigned
  // tower controller bridges both.
  | "chat:booth"
  | "voice:speak"
  | "plugin:use"
  | "controller:assume"
  // Booth moderation: kill-switch publish/text in the spectator booth from a
  // controller seat. Granted at controller+ so the assigned tower controller
  // (and any mod riding in the booth) can shut down a noisy booth without
  // bouncing through /admin.
  | "booth:moderate"
  | "mod:mute"
  | "mod:ban_temp"
  | "mod:ban_perm"
  | "mod:ban_ip"
  | "owner:grant_role";

export const ROLE_RANK: Record<Role, number> = {
  guest: 0,
  pilot: 1,
  controller: 2,
  mod: 3,
  supermod: 4,
  owner: 5
};

export function roleAtLeast(actor: Role, min: Role): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[min];
}

const CAPS_BY_MIN_ROLE: Array<[Capability, Role]> = [
  ["chat:lobby", "guest"],
  ["chat:session", "pilot"],
  // Guests are intentionally excluded from DMs: a 1:1 thread between a real
  // user and a throwaway guest_xxx id is a moderation / spam vector and the
  // guest can't be re-contacted once their token expires anyway.
  ["chat:dm", "pilot"],
  // Booth chat baseline matches session chat — pilot+. Guests stay locked out
  // (same anti-spam reasoning as DMs); the route handler additionally requires
  // the caller be a registered spectator or the assigned tower controller of
  // the specific session, so the capability is necessary but not sufficient.
  ["chat:booth", "pilot"],
  ["voice:speak", "pilot"],
  ["plugin:use", "pilot"],
  ["controller:assume", "controller"],
  // Booth kill-switch: the tower seat (controller+) and mods can mute the
  // entire spectator booth. Pilots cannot (they aren't in the booth at all).
  ["booth:moderate", "controller"],
  ["mod:mute", "mod"],
  ["mod:ban_temp", "mod"],
  ["mod:ban_ip", "mod"],
  ["mod:ban_perm", "supermod"],
  ["owner:grant_role", "owner"]
];

export function capabilitiesFor(role: Role): Set<Capability> {
  const out = new Set<Capability>();
  for (const [cap, min] of CAPS_BY_MIN_ROLE) {
    if (roleAtLeast(role, min)) out.add(cap);
  }
  return out;
}

export function isOwnerImmuneId(userId: string): boolean {
  return Boolean(env.OWNER_USER_ID && env.OWNER_USER_ID === userId);
}

export interface TelemetrySample {
  /** KSP vessel name (in-game ship name). */
  craftName?: string;
  /** Pilot callsign (same as account display name / `pilotName` in telemetry). */
  pilotName?: string;
  /**
   * ATC-style session callsign (e.g. DARWIN-A12). On ingest, the server copies the
   * authoritative value from the session row when set; otherwise accepts the plugin echo.
   */
  callsign?: string;
  /** KSP vessel classification (e.g. Ship, Plane, Probe). */
  craftType?: string;
  /** Map marker: plane, surface rover, or rocket/default. */
  craftMapIcon?: "plane" | "rover" | "rocket";
  /**
   * Player-chosen "stock craft" silhouette key surfaced by the ghost-fleet renderer in other
   * clients. Empty / undefined = the receiver falls back to `craftMapIcon`. Roster lives in
   * the in-game plugin (`TowerGhostRoster`) so this column stays a free-form short string.
   */
  ghostCraftKey?: string;
  /**
   * Pilot turned the GHO switch off in the radio panel — opted out of the ghost-fleet
   * presence layer. `/v1/tower/active-aircraft` filters these sessions out so the pilot
   * doesn't appear in other tower views. Telemetry-driven controller features (strip,
   * scoring) are unaffected.
   */
  ghostOptOut?: boolean;
  universalTime?: number;
  bodyName?: string;
  situation?: string;
  /** KSP biome under the vessel (e.g. "Shores", "Highlands"). Empty when no biome map exists. */
  biome?: string;
  lat?: number;
  lon?: number;
  radarAlt?: number;
  aslAlt?: number;
  surfaceSpeed?: number;
  verticalSpeed?: number;
  heading?: number;
  /** Ground track (deg); ghost DR uses this; nose heading is `heading`. */
  surfaceTrack?: number;
  pitch?: number;
  roll?: number;
  /** Angle of attack in degrees (between vessel forward and surface velocity). */
  aoa?: number;
  throttle?: number;
  gearDown?: boolean;
  brakes?: boolean;
  lights?: boolean;
  rcs?: boolean;
  sas?: boolean;
  apoapsis?: number;
  periapsis?: number;
  gLoad?: number;
  /** Vessel total mass in tonnes (parts + resources). */
  wetMass?: number;
  /** Vessel structural mass in tonnes (parts only). */
  dryMass?: number;
  /** Occupied crew seats. */
  crewCurrent?: number;
  /** Total crew capacity across all parts. */
  crewCapacity?: number;
  /** Names of currently boarded kerbals. */
  crewNames?: string[];
  /** Kerbalism radiation in rad/s when Kerbalism is installed. Kept top-level for one release of back-compat; prefer `kerbalism.radiation` going forward (per KERBALISM_TELEMETRY_PLAN.md §2). */
  radiation?: number;
  /** True when Kerbalism radiation reading is present. */
  radiationAvailable?: boolean;
  /** True when the plugin reached Kerbalism's reflection API at all. The `kerbalism` block is only emitted when this is true. */
  kerbalismAvailable?: boolean;
  /**
   * Kerbalism life-support burn-down + per-crew dose + storm window. Brought
   * forward from KERBALISM_TELEMETRY_PLAN.md Phase 4 onto the Tower Desk.
   * Each sub-block is independently optional.
   */
  kerbalism?: {
    lifeSupport?: Record<
      string,
      {
        amount: number;
        max: number;
        ratePerSec: number;
        secondsRemaining: number | null;
        daysRemaining: number | null;
      }
    >;
    crew?: Array<{ name: string; doseRad: number }>;
    storm?: { incoming: boolean; durationSec?: number };
  };
  /**
   * Per-kerbal stock stats array — trait, level, courage, stupidity,
   * veteran/badass. Empty when the plugin build predates the Phase 4 bring-
   * forward; consumer falls back to `crewNames` in that case.
   */
  crewStats?: Array<{
    name: string;
    trait: string;
    type: string;
    experienceLevel: number;
    experience: number;
    courage: number;
    stupidity: number;
    isVeteran: boolean;
    isBadass: boolean;
  }>;
  /** True when stock CommNet is enabled in the player's save (i.e. Vessel.Connection != null). */
  commNetAvailable?: boolean;
  /** True when the vessel currently has any CommNet path (relay or direct). Only meaningful when commNetAvailable. */
  commLink?: boolean;
  /** True when the vessel has a CommNet path back to KSC (controllable). Subset of commLink. */
  commLinkHome?: boolean;
  /** Stock CommNet signal strength, 0..1. Only meaningful when commNetAvailable. */
  commSignal?: number;
  targetRunway?: string;
  sampleUnixMs?: number;
  smoothedPositionValid?: boolean;
  smoothedLat?: number;
  smoothedLon?: number;
  smoothedAslAlt?: number;
  srfVelNorth?: number;
  srfVelEast?: number;
  srfVelUp?: number;
  distKSC?: number;
  bearingKSC?: number;
  alignErr?: number;
  activeRunway?: string;
  kscAerodrome?: string;
  onApproach?: boolean;
  landing?: boolean;
  flightPhase?: string;
  touchdownEtaSec?: number;
  fuelLow?: boolean;
  radioFreqMhz?: number;
  radioPtt?: boolean;
  /** FAR (Ferram Aerospace Research) surface controls when installed. */
  far?: {
    available: boolean;
    flap: number;
    spoiler: boolean;
  };
}

/** JSON shape stored in `sessions.checklist_state`. */
export interface ChecklistState {
  pilot: Record<string, { doneAt: string; byUserId: string }>;
  controller: Record<string, { doneAt: string; byUserId: string }>;
}

export type ChecklistSide = "pilot" | "controller";

/**
 * Optional auto-tick rule on a checklist item. Evaluated server-side after every
 * `setTelemetry`. `expr` is intentionally a small DSL we control end-to-end so a
 * malformed rule from an old client can never execute arbitrary code; see
 * {@link evaluateAutoRule} for the supported operators.
 *
 * Examples:
 *   { kind: "telemetry", expr: "gearDown == false" }     // Gear up
 *   { kind: "telemetry", expr: "sas == true" }           // SAS on
 *   { kind: "telemetry", expr: "throttle >= 0.95" }      // Full throttle
 *   { kind: "telemetry", expr: "radarAlt > 1000" }       // Above 1000m AGL
 *   { kind: "telemetry", expr: "apoapsis >= 80000" }     // Orbital apo reached
 */
export interface ChecklistAutoRule {
  kind: "telemetry";
  expr: string;
}

export interface ChecklistItemDef {
  id: string;
  label: string;
  /** Optional rule that auto-ticks the item on the pilot side when telemetry matches. */
  autoRule?: ChecklistAutoRule;
}

/**
 * One phase of a checklist (e.g. "Pre-taxi", "Takeoff"). Mirrors the wire shape used by
 * the web (CHECKLIST_PHASES) and the in-game GUI. Stored as a JSON blob in either
 * `sessions.checklist_phases` (per-session override) or `checklist_templates.phases_json`
 * (saved per-user/per-craft/global template).
 */
export interface ChecklistPhaseDef {
  id: string;
  title: string;
  pilot: ChecklistItemDef[];
  controller: ChecklistItemDef[];
}

export type ChecklistTemplateScope = "user" | "craft" | "global";

export interface ChecklistTemplateRecord {
  id: string;
  ownerUserId: string;
  scope: ChecklistTemplateScope;
  craftName?: string;
  name: string;
  isDefault: boolean;
  phases: ChecklistPhaseDef[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Why the controller's telemetry view is not currently being updated. Pushed by the
 * KSP plugin via `POST /telemetry-status/:sessionId` whenever the publisher chooses
 * not to send a sample. `live` is implicit (and re-asserted) every time `setTelemetry`
 * succeeds, so the controller's UI flips back automatically the moment fresh data
 * arrives. `stale` is never pushed by the plugin — it's derived server-side in the
 * `/session` GET when no telemetry has arrived for ~3× the recommended cadence
 * (covers crashes / network drops / KSP CTD where the plugin can't post a goodbye).
 */
export type TelemetryHealthState =
  | "live"
  | "beacon_off"
  | "paused"
  | "scene_left"
  | "warp"
  | "vessel_dead"
  | "vessel_switch"
  | "stale";

export interface TelemetryStatusEvent {
  /** Plugin-reported reason; never `live` or `stale` (those are implicit/derived). */
  state: Exclude<TelemetryHealthState, "live" | "stale">;
  /** ISO8601 of when the plugin reported the transition. */
  at: string;
  /** Optional human-readable detail (e.g. "warp 100x", "Returned to Space Center"). */
  message?: string;
}

export interface SessionRecord {
  id: string;
  pilotUserId: string;
  assignedTowerUserId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  blockedUserIds: string[];
  /**
   * User ids currently spectating this room (read-only listeners). Spectators can
   * subscribe to chat / telemetry / voice but cannot publish, rename, advance the
   * tower rotation, block, or close the room. Self-managed via
   * `addSessionSpectator` / `removeSessionSpectator`; cleared automatically on
   * `closeSession` since the room is going away.
   */
  spectatorUserIds: string[];
  telemetry?: TelemetrySample;
  /** Ephemeral RF occupancy derived from recent radio telemetry; not persisted. */
  radioState?: RadioState;
  /**
   * ISO8601 timestamp of the most recent successful `POST /telemetry/:sessionId`.
   * Used to derive the `stale` health state when the plugin stops posting without
   * sending an explicit going-dark status (KSP CTD, network drop, alt-tab freeze).
   */
  lastTelemetryAt?: string;
  /**
   * Last "going dark" reason pushed by the plugin. Cleared on the next successful
   * telemetry POST so a healthy stream automatically returns the UI to `live`.
   */
  telemetryStatus?: TelemetryStatusEvent;
  /** 4-digit ATC squawk; never the reserved 7500/7600/7700 (and never 0000). */
  squawk?: string;
  callsign?: string;
  /**
   * Human-set name for the lobby's "Tower room" entry (e.g. "Bobcat 7 morning practice",
   * "Mun launch attempt 3"). Auto-filled at create-time from the callsign if the caller
   * doesn't supply one, so this should be defined for every freshly-created session and
   * only `undefined` for legacy rows minted before this column existed. The lobby falls
   * back to a derived label when truly absent — never to the raw `tower-{UUID}`. Always
   * distinct from the LiveKit room name, which stays `tower-{sessionId}`. See the
   * "Room" / "Room name" glossary entries.
   */
  name?: string;
  /**
   * Notional VHF aviation-band frequency (e.g. "118.300") auto-assigned at create-time.
   * Cosmetic — gives the lobby card a "real radio" feel; no routing logic depends on it.
   * Stable per session id (deterministic hash). See `defaultFrequencyMhz`.
   */
  frequencyMhz?: string;
  checklistState?: ChecklistState;
  /**
   * Per-session override of the checklist item set. When present, the web UI and the
   * in-game GUI use these phases instead of the hardcoded `CHECKLIST_PHASES` template.
   * Set by template-apply / send-to-tower / in-session add/rename/remove edits.
   */
  checklistPhases?: ChecklistPhaseDef[];
  countdownStartsAt?: string;
  countdownLengthSec?: number;
  /**
   * Latest pilot-side countdown request marker (ephemeral, in-memory only).
   * Lets tower surfaces show "pilot requested countdown" as structured status
   * instead of scraping/parsing chat text.
   */
  countdownRequest?: {
    at: string;
    byUserId: string;
    label?: string;
  };
  /**
   * Latest pilot-side **takeoff clearance** ping (planes/rovers). Ephemeral, in-memory.
   * Mutually exclusive with {@link countdownRequest} in API handlers so tower UI shows one primary ask.
   */
  takeoffRequest?: {
    at: string;
    byUserId: string;
    label?: string;
  };
  /**
   * Server time (ISO) of the last tower **cleared for takeoff** (pilot-pending grant or
   * clearance strip). Echoed on telemetry as `takeoffClearanceAtMs` for in-game button feedback.
   * In-memory only.
   */
  takeoffClearanceAt?: string;
  /**
   * Booth kill-switch: when true, the spectator commentary booth is gagged —
   * spectators in the booth lose publish on the booth voice room and are
   * blocked from POSTing to the booth chat thread until the assigned tower /
   * mod flips this back off. Stored only in the in-memory `localSessions` map
   * (no DB column on purpose: this is an ephemeral moderation state, and a
   * backend restart is a perfectly fine implicit unmute). Defaults to false.
   */
  boothMuted?: boolean;
  /**
   * Operator-placed map waypoints shared with everyone in the room (pilot,
   * controller, spectators). Populated by `addSessionSharedWaypoint` from the
   * tower map's click-pick pill. Stored in-memory only (same rationale as
   * `boothMuted`: ephemeral collaborative state, backend restart wipes them).
   * Capped at `MAX_SESSION_SHARED_WAYPOINTS` so a misbehaving client can't
   * pump the session record full of garbage. Sorted oldest → newest.
   */
  sharedWaypoints?: SharedWaypoint[];
  /**
   * Room-scoped Dragon Radar minigame state. In-memory only (same lifecycle as
   * shared waypoints / booth mute): ephemeral collaborative state that can reset
   * on backend restart without migration complexity.
   */
  dragonRadarGame?: DragonRadarGameState;
  /**
   * Tower-set clearance strip (persisted when DB available). Distinct from
   * {@link recentViolations} automatic RP flags.
   */
  clearances?: SessionClearances;
  /** Optional expected landing runway id (e.g. "09") for wrong-runway detection. */
  expectedLandingRunway?: string;
  /** Append-only phase history (in-memory; not persisted to DB). */
  phaseTimeline?: Array<{ code: string; at: string }>;
  /** Recent automatic violation events (in-memory). */
  recentViolations?: ViolationEvent[];
  /** Last landing quality tier from server heuristics (in-memory). */
  lastLandingQuality?: "GOOD" | "HARD" | "OFF_CENTER";
  /**
   * Tower-issued “stage here” hint for the pilot game client (e.g. Vessel Mover). Ephemeral,
   * in-memory; echoed on telemetry for the plugin to consume and clear locally.
   */
  stagingMoveRequest?: StagingMoveRequest;
}

/**
 * One operator-placed pin on the tower map, shared with everyone in the room.
 *
 * `bodyName` is recorded so a waypoint placed on Kerbin doesn't bleed onto the
 * Mun map (or vice-versa) — the frontend filters by the currently-viewed body.
 * Lat/lon are degrees in the standard `[-90, 90] / [-180, 180]` ranges. Color
 * is an optional `#rrggbb` hex string the operator can pick to distinguish
 * groups of waypoints (e.g. orange = recovery zone, cyan = surveillance);
 * absent = the frontend uses its default purple swatch.
 */
export interface SharedWaypoint {
  id: string;
  bodyName: string;
  lat: number;
  lon: number;
  label?: string;
  color?: string;
  createdAt: string;
  createdBy: string;
}

/** Cap on the in-memory shared-waypoint list per session. Older entries are dropped FIFO. */
export const MAX_SESSION_SHARED_WAYPOINTS = 64;

export type DragonRadarCombatKind = "hit" | "kill";

export interface DragonRadarBallState {
  id: string;
  bodyName: string;
  lat: number;
  lon: number;
  aslAlt: number;
  carrierSessionId?: string;
  collectedBySessionId?: string;
  collectedAt?: string;
}

export interface DragonRadarCrewReviveOffer {
  offeredAt: string;
  targetSessionId: string;
  consumedAt?: string;
}

export interface DragonRadarGameState {
  gameId: string;
  bodyName: string;
  startedAt: string;
  startedBy: string;
  updatedAt: string;
  version: number;
  balls: DragonRadarBallState[];
  /** One-time per game: when a tower session holds all seven balls, RAD clients revive dead crew then POST ack. */
  crewReviveOffer?: DragonRadarCrewReviveOffer;
  lastCombat?: {
    at: string;
    attackerSessionId: string;
    victimSessionId: string;
    kind: DragonRadarCombatKind;
    movedBalls: number;
  };
}

export interface DragonRadarRules {
  playerRangeKm: number;
  carrierRangeKm: number;
  detailRangeKm: number;
  claimRadiusM: number;
}

/** Mirrors in-game `TowerDragonRadarGui` PPI / claim checks (see web Dragon wall copy). */
export const DRAGON_RADAR_RULES: DragonRadarRules = {
  /** Max slant range (km) to draw another pilot; range ring mapping uses this cap. */
  playerRangeKm: 100,
  /** Pilots carrying a ball stay drawn out to this km (outer-ring direction cue past `playerRangeKm`). */
  carrierRangeKm: 300,
  /** Loose ball: detailed blip + label within this km; beyond = coarse rim blip (still ≤ carrierRangeKm). */
  detailRangeKm: 10,
  /** Server claim: great-circle metres from pilot lat/lon to ball lat/lon while landed (see claim handler). */
  claimRadiusM: 100
};

export interface ReportRecord {
  id: string;
  reporterUserId: string;
  targetUserId?: string;
  sessionId?: string;
  reason: string;
  createdAt: string;
}

interface ActionLogRecord {
  id: string;
  at: string;
  actorUserId: string;
  action: string;
  metadata?: Record<string, unknown>;
}

export interface UserAccess {
  userId: string;
  role: Role;
  isBanned: boolean;
  isMuted: boolean;
  /** Effective capability set computed from `role`. Computed server-side so the UI is dumb. */
  capabilities: Set<Capability>;
}

export interface GuestRecord {
  id: string;
  ip: string;
  displayName: string;
}

const localTowerQueue = new Set<string>();
const localSessions = new Map<string, SessionRecord>();
const DEV_SHARED_SESSION_ID = "dev-shared";
const localReports: ReportRecord[] = [];

// In-memory session cache bounds. Sized so a long-uptime instance with normal
// session churn doesn't grow the heap forever — every `getSession` re-populates
// from the DB on miss, so eviction is safe ONLY when DB persistence is on
// (in-memory-only mode keeps everything because the cache *is* the system of
// record). The sweeper runs once a minute and is unref'd so it never holds the
// process alive on its own.
const LOCAL_SESSIONS_SOFT_CAP = 512;
const LOCAL_SESSIONS_HARD_CAP = 1024;
/** Closed sessions older than this are dropped from the in-memory cache. */
const CLOSED_SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const LOCAL_SESSIONS_SWEEP_INTERVAL_MS = 60_000;
let localSessionsSweeperHandle: NodeJS.Timeout | null = null;

function sweepLocalSessions(): void {
  // Skip when DB is not authoritative — eviction would be destructive (the
  // cache is the only copy of the row).
  if (!useDbPersistence()) return;
  if (localSessions.size <= LOCAL_SESSIONS_SOFT_CAP) return;

  const cutoff = Date.now() - CLOSED_SESSION_CACHE_TTL_MS;
  for (const [id, s] of localSessions) {
    if (id === DEV_SHARED_SESSION_ID) continue;
    if (s.status !== "closed") continue;
    const updatedMs = Date.parse(s.updatedAt);
    if (Number.isFinite(updatedMs) && updatedMs < cutoff) {
      localSessions.delete(id);
    }
  }

  if (localSessions.size <= LOCAL_SESSIONS_HARD_CAP) return;

  // Hard-cap fallback: evict **closed** sessions before **active** ones (then oldest
  // `updatedAt` first). `countdownRequest` / `takeoffRequest` / `stagingMoveRequest` /
  // booth mute / shared waypoints live only in this map — never in `mapSessionRow` —
  // so deleting an
  // active row would silently drop pilot pings until the next POST recreates them.
  const candidates = [...localSessions.entries()]
    .filter(([id]) => id !== DEV_SHARED_SESSION_ID)
    .sort((a, b) => {
      const aClosed = a[1].status === "closed" ? 0 : 1;
      const bClosed = b[1].status === "closed" ? 0 : 1;
      if (aClosed !== bClosed) return aClosed - bClosed;
      return a[1].updatedAt.localeCompare(b[1].updatedAt);
    });
  const drop = localSessions.size - LOCAL_SESSIONS_HARD_CAP;
  for (let i = 0; i < drop; i++) {
    const e = candidates[i];
    if (e) localSessions.delete(e[0]);
  }
  logger.warn(
    { remaining: localSessions.size, evicted: drop, hardCap: LOCAL_SESSIONS_HARD_CAP },
    "localSessions exceeded hard cap; evicted oldest-updatedAt entries (DB still authoritative)"
  );
}

function ensureLocalSessionsSweeper(): void {
  if (localSessionsSweeperHandle !== null) return;
  localSessionsSweeperHandle = setInterval(() => {
    try {
      sweepLocalSessions();
    } catch (err) {
      logger.warn({ err }, "localSessions sweep failed");
    }
  }, LOCAL_SESSIONS_SWEEP_INTERVAL_MS);
  localSessionsSweeperHandle.unref?.();
}

ensureLocalSessionsSweeper();

interface LocalBanRecord {
  userId: string;
  ip?: string;
  kind: "ban" | "mute";
  expiresAtMs?: number;
  reason?: string;
}

/**
 * One local entry per (user_id, kind). Using an array per user lets a single principal
 * carry both an active ban *and* an active mute simultaneously, mirroring the DB after
 * the bans-table PK change to `(user_id, kind)`. The previous `Map<string,LocalBanRecord>`
 * silently overwrote a ban with a later mute (and vice versa), collapsing the two states.
 */
const localBans = new Map<string, LocalBanRecord[]>();
const localGuests = new Map<string, GuestRecord>();
const localUserRoles = new Map<string, Role>();
const localLogs: ActionLogRecord[] = [];
/**
 * Per-user display-name override. Layered on top of the JWT-issued display
 * name so a user can rename themselves from the Settings page without us
 * having to mint a fresh session token. /v1/auth/me consults this map first
 * and falls back to whatever was encoded in the session cookie.
 *
 * For self-registered users, the value is also persisted to the registered-
 * users JSON store via `setRegisteredUserDisplayName` so it survives a
 * restart. For env-managed (`WEB_LOGIN_USERS_JSON`) users and guests the map
 * is the only source of truth — restart wipes their custom name back to the
 * env / auto-generated default.
 */
const localUserDisplayNames = new Map<string, string>();

function localBanIsActive(rec: LocalBanRecord, kind?: "ban" | "mute"): boolean {
  if (kind && rec.kind !== kind) return false;
  if (rec.expiresAtMs == null) return true;
  return rec.expiresAtMs > Date.now();
}

function setLocalBan(rec: LocalBanRecord): void {
  const list = localBans.get(rec.userId) ?? [];
  const next = list.filter((existing) => existing.kind !== rec.kind);
  next.push(rec);
  localBans.set(rec.userId, next);
}

/**
 * Remove the in-memory ban/mute record for a user. Returns true if a record
 * was actually removed (so the caller can decide whether the lift was a no-op).
 * Used by `unbanUser` / `unmuteUser` to mirror the DB delete.
 */
function clearLocalBan(userId: string, kind: "ban" | "mute"): boolean {
  const list = localBans.get(userId);
  if (!list) return false;
  const next = list.filter((rec) => rec.kind !== kind);
  if (next.length === list.length) return false;
  if (next.length === 0) localBans.delete(userId);
  else localBans.set(userId, next);
  return true;
}

function getActiveLocalRecord(userId: string, kind: "ban" | "mute"): LocalBanRecord | undefined {
  const list = localBans.get(userId);
  if (!list) return undefined;
  return list.find((rec) => localBanIsActive(rec, kind));
}

function* iterLocalBans(): Generator<LocalBanRecord> {
  for (const list of localBans.values()) {
    for (const rec of list) {
      yield rec;
    }
  }
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  fromUserId: string;
  body: string;
  createdAt: string;
}

const localSessionMessages = new Map<string, SessionMessage[]>();
const LOBBY_SESSION_ID = "__lobby__";

/**
 * Hard cap on per-session in-memory chat history. The previous behaviour
 * appended forever, which let an authenticated client OOM the box by sending
 * 4 KB messages in a tight loop. We keep the most recent 1000 messages per
 * session in memory; the DB still holds the full archive when persistence is on.
 */
const SESSION_MESSAGE_MEMORY_CAP = 1000;

const TOWER_QUEUE_KEY = "queue:tower:zset";
const SERVER_RADIO_OWNER_USER_ID = "system:radio";
const SERVER_RADIO_SESSION_PREFIX = "ksc-radio-";
const SERVER_RADIO_SHARED_OPS_ROOM = "tower-ksc-radio-shared";
const SERVER_RADIO_ROOM_NAMES: Record<string, string> = {
  twr: "KSC Tower",
  gnd: "KSC Ground",
  emrg: "Global Emergency"
};
const SERVER_RADIO_PRESET_IDS = new Set(Object.keys(SERVER_RADIO_ROOM_NAMES));

function nowIso(): string {
  return new Date().toISOString();
}

function useDbPersistence(): boolean {
  // Three ways to land in in-memory mode:
  //   1. Operator forced it via DEV_IN_MEMORY=1.
  //   2. Startup pingDb() failed and lib/db marked the pool as skipped.
  // Without this isDbAvailable() check, every middleware/route call (e.g.
  // loadIpBan -> isIpBanned) would block 5-10s waiting on the pool to
  // acquire, then fall through, making login appear to "fail with 401" only
  // after the timeout expired.
  if (env.DEV_IN_MEMORY) return false;
  return isDbAvailable();
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** DB-backed fields only — in-memory-only `SessionRecord` keys are absent here on purpose. */
function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    pilotUserId: String(row.pilot_user_id),
    assignedTowerUserId: row.assigned_tower_user_id ? String(row.assigned_tower_user_id) : undefined,
    status: String(row.status) as SessionStatus,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    blockedUserIds: safeJsonParse<string[]>(row.blocked_users_json, []),
    spectatorUserIds: safeJsonParse<string[]>(row.spectator_user_ids_json, []),
    telemetry: safeJsonParse<TelemetrySample | undefined>(row.telemetry_json, undefined),
    squawk: row.squawk ? String(row.squawk) : undefined,
    callsign: row.callsign ? String(row.callsign) : undefined,
    name: row.name ? String(row.name) : undefined,
    frequencyMhz: row.frequency_mhz ? String(row.frequency_mhz) : undefined,
    checklistState: safeJsonParse<ChecklistState | undefined>(row.checklist_state, undefined),
    checklistPhases: safeJsonParse<ChecklistPhaseDef[] | undefined>(row.checklist_phases, undefined),
    countdownStartsAt: row.countdown_starts_at
      ? new Date(String(row.countdown_starts_at)).toISOString()
      : undefined,
    countdownLengthSec:
      row.countdown_length_sec != null ? Number(row.countdown_length_sec) : undefined,
    clearances: (() => {
      const c = safeJsonParse<SessionClearances | undefined>(row.clearances_json, undefined);
      if (c && typeof c === "object" && Object.keys(c).length === 0) return undefined;
      return c;
    })(),
    expectedLandingRunway: row.expected_landing_runway ? String(row.expected_landing_runway) : undefined
  };
}

async function withConn<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const pool = getDbPool();
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function ensureUser(clerkUserId: string): Promise<void> {
  if ((env.NODE_ENV === "development" || env.NODE_ENV === "test") && env.DEV_OPEN_AUTH) {
    // In local open-auth mode we intentionally avoid DB round trips.
    return;
  }
  try {
    await withConn(async (conn) => {
      await conn.query(
        `
        INSERT INTO users (clerk_user_id, role)
        VALUES (?, 'pilot')
        ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
        `,
        [clerkUserId]
      );
    });
  } catch (error) {
    logger.warn({ err: error }, "Failed to upsert user row");
  }
}

function makeAccess(userId: string, role: Role, isBanned: boolean, isMuted: boolean): UserAccess {
  return { userId, role, isBanned, isMuted, capabilities: capabilitiesFor(role) };
}

function isGuestId(userId: string): boolean {
  return userId.startsWith("guest_");
}

export async function getUserAccess(userId: string): Promise<UserAccess> {
  // Owner immunity: bypass DB / bans entirely so a SQL accident or self-ban can't lock you out.
  if (isOwnerImmuneId(userId)) {
    return makeAccess(userId, "owner", false, false);
  }

  // Dev open-auth: dev principal gets the configured DEV_USER_ROLE so the UI shows what you want.
  if (
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    userId === env.DEV_USER_ID &&
    (env.DEV_OPEN_AUTH || !!env.DEV_BEARER_SECRET)
  ) {
    return makeAccess(
      userId,
      env.DEV_USER_ROLE,
      !!getActiveLocalRecord(userId, "ban"),
      !!getActiveLocalRecord(userId, "mute")
    );
  }

  // Guest sessions never go through the `users` table — role is fixed and bans are checked separately.
  if (isGuestId(userId)) {
    return makeAccess(
      userId,
      "guest",
      !!getActiveLocalRecord(userId, "ban"),
      !!getActiveLocalRecord(userId, "mute")
    );
  }

  if (!useDbPersistence()) {
    const role = localUserRoles.get(userId);
    if (!role) {
      throw new MissingUserRoleError(userId);
    }
    return makeAccess(
      userId,
      role,
      !!getActiveLocalRecord(userId, "ban"),
      !!getActiveLocalRecord(userId, "mute")
    );
  }

  await ensureUser(userId);
  // No try/catch: if the DB blew up here, surfacing the error is the right
  // call. Returning a fabricated role would be the very thing this audit is
  // killing. Operator sees a 500, fixes the DB, moves on.
  const result = await withConn(async (conn) => {
    const userRows = (await conn.query(
      `SELECT role, is_banned FROM users WHERE clerk_user_id = ? LIMIT 1`,
      [userId]
    )) as Array<Record<string, unknown>>;
    // The bans table now uses PK (user_id, kind), so a user can have BOTH a ban
    // and a mute row at the same time. Fetch every active row and OR them together.
    const banRows = (await conn.query(
      `
      SELECT kind
      FROM bans
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())
      `,
      [userId]
    )) as Array<Record<string, unknown>>;
    return { user: userRows[0], bans: banRows };
  });

  if (!result.user) {
    // ensureUser() just upserted this row. If it isn't here, something
    // race-y or destructive happened between the upsert and the SELECT
    // (replication lag against a read replica, manual DELETE, etc).
    throw new MissingUserRoleError(userId);
  }
  const rawRole = String(result.user.role);
  if (!(rawRole in ROLE_RANK)) {
    throw new Error(
      `users.role='${rawRole}' for userId='${userId}' is not a known role (${Object.keys(ROLE_RANK).join("|")}).`
    );
  }
  const role = rawRole as Role;
  const kinds = new Set(result.bans.map((r) => String(r.kind ?? "ban")));
  const isBanned = kinds.has("ban") || Boolean(result.user.is_banned);
  const isMuted = kinds.has("mute");
  return makeAccess(userId, role, isBanned, isMuted);
}

/**
 * Idempotent role-seed for principals minted at the auth boundary (e.g. the
 * dev voice-bridge identity injected via DEV_VOICE_IDENTITY_HEADER). If the
 * userId already has a role, this is a no-op so any runtime demotion sticks.
 * Use this instead of `setUserRole` when there is no real "actor" performing
 * an admin action — this is just registering a known principal's default role.
 */
export function ensureLocalRoleSeeded(userId: string, role: Role): void {
  if (localUserRoles.has(userId)) return;
  if (!(role in ROLE_RANK)) {
    throw new Error(`ensureLocalRoleSeeded: unknown role '${role}' for userId='${userId}'`);
  }
  localUserRoles.set(userId, role);
}

/**
 * Seeds `localUserRoles` from WEB_LOGIN_USERS_JSON / DEV_DEFAULT_WEB_USER so
 * `getUserAccess` finds a role for every configured web user immediately,
 * without relying on `/v1/auth/login` having been hit first. Idempotent —
 * call from server bootstrap. Existing roles (set via the admin API at
 * runtime) are NOT overwritten so a manual demotion survives a config reload.
 */
export function seedConfiguredWebUserRoles(): void {
  const users = listConfiguredWebUsers();
  for (const u of users) {
    if (localUserRoles.has(u.userId)) continue;
    if (!(u.role in ROLE_RANK)) {
      logger.warn(
        { userId: u.userId, role: u.role },
        "Configured web user has unknown role; skipping seed"
      );
      continue;
    }
    localUserRoles.set(u.userId, u.role as Role);
    logger.info({ userId: u.userId, email: u.email, role: u.role }, "Seeded role for configured web user");
  }
}

async function isUserBanned(userId: string): Promise<boolean> {
  const access = await getUserAccess(userId);
  return access.isBanned;
}

export async function isIpBanned(ip: string | undefined): Promise<boolean> {
  if (!ip) return false;
  for (const rec of iterLocalBans()) {
    if (rec.ip === ip && localBanIsActive(rec, "ban")) {
      return true;
    }
  }
  if (!useDbPersistence()) return false;
  try {
    return await withConn(async (conn) => {
      const rows = (await conn.query(
        `
        SELECT 1 FROM bans
        WHERE ip = ? AND kind = 'ban' AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
        `,
        [ip]
      )) as Array<Record<string, unknown>>;
      return rows.length > 0;
    });
  } catch {
    return false;
  }
}

export async function setUserRole(targetUserId: string, role: Role, actorUserId: string): Promise<void> {
  if (isOwnerImmuneId(targetUserId)) {
    throw new Error("Cannot change role of immune owner principal");
  }
  if (!(role in ROLE_RANK)) {
    throw new Error(`Unknown role: ${role}`);
  }
  localUserRoles.set(targetUserId, role);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO users (clerk_user_id, role)
          VALUES (?, ?)
          ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP
          `,
          [targetUserId, role]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist role change");
    }
  }
  await logAction(actorUserId, "admin.role.set", { targetUserId, role });
}

export async function muteUser(
  targetUserId: string,
  durationSeconds: number,
  actorUserId: string,
  reason?: string
): Promise<void> {
  if (isOwnerImmuneId(targetUserId)) {
    throw new Error("Cannot mute the immune owner principal");
  }
  const expiresAtMs = Date.now() + Math.max(1, Math.floor(durationSeconds)) * 1000;
  setLocalBan({ userId: targetUserId, kind: "mute", expiresAtMs, reason });

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO bans (user_id, banned_by_user_id, reason, kind, expires_at)
          VALUES (?, ?, ?, 'mute', FROM_UNIXTIME(? / 1000))
          ON DUPLICATE KEY UPDATE
            banned_by_user_id = VALUES(banned_by_user_id),
            reason = VALUES(reason),
            kind = VALUES(kind),
            expires_at = VALUES(expires_at)
          `,
          [targetUserId, actorUserId, reason ?? null, expiresAtMs]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist mute");
    }
  }
  await logAction(actorUserId, "admin.mute", { targetUserId, expiresAtMs, reason });
}

export async function banGuestIp(
  guestId: string,
  ip: string,
  actorUserId: string,
  reason?: string,
  durationSeconds?: number
): Promise<void> {
  const expiresAtMs = durationSeconds ? Date.now() + Math.max(1, durationSeconds) * 1000 : undefined;
  setLocalBan({ userId: guestId, ip, kind: "ban", expiresAtMs, reason });

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO bans (user_id, banned_by_user_id, reason, kind, ip, expires_at)
          VALUES (?, ?, ?, 'ban', ?, ${expiresAtMs ? `FROM_UNIXTIME(? / 1000)` : `NULL`})
          ON DUPLICATE KEY UPDATE
            banned_by_user_id = VALUES(banned_by_user_id),
            reason = VALUES(reason),
            kind = VALUES(kind),
            ip = VALUES(ip),
            expires_at = VALUES(expires_at)
          `,
          expiresAtMs
            ? [guestId, actorUserId, reason ?? null, ip, expiresAtMs]
            : [guestId, actorUserId, reason ?? null, ip]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist guest IP ban");
    }
  }
  await logAction(actorUserId, "admin.banIp", { guestId, ip, expiresAtMs, reason });
}

/**
 * Cap on in-memory guest registry. Each guest_xxx token is short-lived (12 h)
 * and the actual persistence story is the DB; this map is just a fast-path
 * cache. Without a cap an attacker could mint guest tokens at the rate-limited
 * cadence indefinitely and grow the heap.
 */
const LOCAL_GUEST_CAP = 10_000;

export async function registerOrTouchGuest(
  guestId: string,
  ip: string,
  displayName: string
): Promise<GuestRecord> {
  const record: GuestRecord = { id: guestId, ip, displayName };
  if (localGuests.size >= LOCAL_GUEST_CAP && !localGuests.has(guestId)) {
    // Drop the oldest entry (Map iteration order = insertion order).
    const firstKey = localGuests.keys().next().value;
    if (firstKey !== undefined) localGuests.delete(firstKey);
  }
  localGuests.set(guestId, record);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO guests (id, ip, display_name)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE
            ip = VALUES(ip),
            display_name = VALUES(display_name),
            last_seen_at = CURRENT_TIMESTAMP
          `,
          [guestId, ip, displayName]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist guest");
    }
  }
  return record;
}

export async function getGuestById(guestId: string): Promise<GuestRecord | undefined> {
  const local = localGuests.get(guestId);
  if (local) return local;
  if (!useDbPersistence()) return undefined;
  try {
    return await withConn(async (conn) => {
      const rows = (await conn.query(
        `SELECT id, ip, display_name FROM guests WHERE id = ? LIMIT 1`,
        [guestId]
      )) as Array<Record<string, unknown>>;
      const r = rows[0];
      if (!r) return undefined;
      return { id: String(r.id), ip: String(r.ip), displayName: String(r.display_name) };
    });
  } catch {
    return undefined;
  }
}

export async function joinTowerQueue(userId: string): Promise<{ size: number }> {
  await ensureUser(userId);
  try {
    const redis = getRedis();
    const score = Date.now();
    await redis.zadd(TOWER_QUEUE_KEY, "NX", score, userId);
    const size = await redis.zcard(TOWER_QUEUE_KEY);
    return { size };
  } catch (error) {
    logger.warn({ err: error }, "Redis queue join failed; using local fallback");
    localTowerQueue.add(userId);
    return { size: localTowerQueue.size };
  }
}

/**
 * Read-only "am I currently in the controller queue, and how big is the queue?"
 * Used by the lobby's controller-mode UI so it can show the right button (Join /
 * Leave) without keeping local state in the SPA. Falls back to the in-memory
 * queue when Redis is unavailable so dev / single-node deployments still work.
 */
export async function getTowerQueueStatus(
  userId: string
): Promise<{ inQueue: boolean; size: number }> {
  try {
    const redis = getRedis();
    const score = await redis.zscore(TOWER_QUEUE_KEY, userId);
    const size = await redis.zcard(TOWER_QUEUE_KEY);
    return { inQueue: score !== null && score !== undefined, size: Number(size) || 0 };
  } catch {
    return { inQueue: localTowerQueue.has(userId), size: localTowerQueue.size };
  }
}

export async function leaveTowerQueue(userId: string): Promise<{ size: number }> {
  try {
    const redis = getRedis();
    await redis.zrem(TOWER_QUEUE_KEY, userId);
    const size = await redis.zcard(TOWER_QUEUE_KEY);
    return { size };
  } catch (error) {
    logger.warn({ err: error }, "Redis queue leave failed; using local fallback");
    localTowerQueue.delete(userId);
    return { size: localTowerQueue.size };
  }
}

export async function nextTowerExcluding(excluded: Set<string>): Promise<string | undefined> {
  try {
    const redis = getRedis();
    const candidates = await redis.zrange(TOWER_QUEUE_KEY, 0, 200);
    for (const userId of candidates) {
      const banned = await isUserBanned(userId);
      if (!excluded.has(userId) && !banned) {
        return userId;
      }
    }
    return undefined;
  } catch {
    for (const userId of localTowerQueue) {
      if (!excluded.has(userId) && !getActiveLocalRecord(userId, "ban")) {
        return userId;
      }
    }
    return undefined;
  }
}

/**
 * Atomically claim the next eligible tower from the queue and assign them to `sessionId`.
 *
 * Replaces the racy `nextTowerExcluding(...) -> assignTower(...)` two-step where two
 * concurrent callers could pick the same controller. The Redis path uses `ZREM` as the
 * single source of truth for "I won the race" — only the caller whose `ZREM` returns 1
 * may proceed to assign. The local fallback uses a small in-process critical section
 * (Node.js is single-threaded; the only concern is interleaving across awaited calls,
 * which we side-step by removing from the Set before any await).
 */
export async function claimNextTowerForSession(
  sessionId: string,
  excluded: Set<string>
): Promise<{ session: SessionRecord | undefined; assigned: string | undefined }> {
  let chosen: string | undefined;
  try {
    const redis = getRedis();
    const candidates = await redis.zrange(TOWER_QUEUE_KEY, 0, 200);
    for (const userId of candidates) {
      if (excluded.has(userId)) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await isUserBanned(userId)) continue;
      // eslint-disable-next-line no-await-in-loop
      const removed = (await redis.zrem(TOWER_QUEUE_KEY, userId)) as number;
      if (removed === 1) {
        chosen = userId;
        break;
      }
      // removed === 0: another process popped them first, try the next candidate.
    }
  } catch {
    for (const userId of localTowerQueue) {
      if (excluded.has(userId)) continue;
      if (getActiveLocalRecord(userId, "ban")) continue;
      localTowerQueue.delete(userId);
      chosen = userId;
      break;
    }
  }

  if (!chosen) {
    return { session: await getSession(sessionId), assigned: undefined };
  }

  const session = await assignTower(sessionId, chosen);
  return { session, assigned: chosen };
}

/**
 * Assign a 4-digit ATC squawk avoiding the reserved emergency codes (7500/7600/7700)
 * and the visually-confusing 0000.
 */
function generateSquawk(): string {
  const reserved = new Set(["7500", "7600", "7700", "0000"]);
  for (let attempt = 0; attempt < 32; attempt++) {
    const n = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    if (!reserved.has(n)) return n;
  }
  return "1200"; // VFR fallback: should never happen.
}

/**
 * Build the auto-callsign root from the most human-readable identifier we have for
 * the pilot. Order of preference:
 *   1. The pilot's display name (what `fdsaf` typed at login / what they see in the
 *      topbar — this is what they'd recognise as "themselves" on the radio).
 *   2. The configured-web-user email local-part, if we can find one for this id.
 *   3. The raw user id (last-resort; for Clerk subjects / unknown principals).
 *
 * Anything non-alphanumeric is stripped and the result is hard-capped at 16 chars
 * so it survives the lobby card / strip without wrapping. Falls back to "PILOT" if
 * every source produced an empty string after cleanup.
 *
 * Previously this used the raw `pilotUserId` directly, which leaked internal ids
 * into the lobby (e.g. a controller-rank user `controller-local-943` ended up with
 * a callsign `controllerlocal-943` and a room name "CONTROLLERLOCAL-943 Tower").
 */
function defaultCallsign(pilotUserId: string, sessionId: string, displayName?: string): string {
  const candidates: string[] = [];
  if (displayName && displayName.trim().length > 0) {
    candidates.push(displayName.trim());
  }
  const configured = listConfiguredWebUsers().find((u) => u.userId === pilotUserId);
  if (configured?.email) {
    const at = configured.email.indexOf("@");
    candidates.push(at > 0 ? configured.email.slice(0, at) : configured.email);
  }
  candidates.push(pilotUserId);

  for (const raw of candidates) {
    const cleaned = raw.replace(/[^A-Za-z0-9]+/g, "").slice(0, 16);
    if (cleaned.length > 0) {
      const tail = sessionId.replace(/[^A-Za-z0-9]+/g, "").slice(0, 3).toUpperCase() || "001";
      return `${cleaned}-${tail}`;
    }
  }
  const tail = sessionId.replace(/[^A-Za-z0-9]+/g, "").slice(0, 3).toUpperCase() || "001";
  return `PILOT-${tail}`;
}

/**
 * Stable hash of a session id for picking deterministic per-session attributes (default
 * room name suffix, default notional frequency, etc). Tiny FNV-1a variant — we just need
 * "deterministic spread", not crypto strength. Same id always returns the same hash.
 */
function sessionIdHash(sessionId: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) | 0;
  }
  return h >>> 0;
}

/**
 * Default lobby room name when the caller doesn't supply one. Format `<CALLSIGN> Tower`,
 * uppercased — e.g. `DARREN-A49 TOWER`. Built from the same callsign that's already
 * threaded through the rest of the session, so the heading the user sees in the lobby
 * matches the callsign on the strip and on the radio. **Never returns a UUID.**
 */
export function defaultRoomName(callsign: string): string {
  const cleaned = (callsign ?? "").trim();
  const safe = cleaned.length > 0 ? cleaned : "TOWER";
  return `${safe.toUpperCase()} Tower`;
}

/**
 * Deterministic notional VHF aviation frequency for a session (118.000 - 136.975 MHz,
 * 25 kHz spacing → 760 valid channels). Cosmetic — gives lobby cards a "real radio"
 * feel ("DARREN-A49 Tower · 118.300") instead of `tower-<UUID>`. Stable per sessionId
 * because it's derived from a hash of the id, so the same session always shows the
 * same frequency across reloads even if it predates the DB column.
 */
export function defaultFrequencyMhz(sessionId: string): string {
  const totalChannels = (137 - 118) * 40;
  const ch = sessionIdHash(sessionId) % totalChannels;
  const mhz = 118 + Math.floor(ch / 40);
  const fraction = (ch % 40) * 25;
  return `${mhz}.${fraction.toString().padStart(3, "0")}`;
}

/**
 * Validates a caller-supplied `NNN.NNN` frequency string. Returns the canonical
 * string when it parses, falls in the 118.000-136.975 MHz aviation VHF band, and
 * is on a 25 kHz channel boundary; returns `undefined` otherwise (the caller
 * then falls back to `defaultFrequencyMhz`). The band/spacing match
 * `defaultFrequencyMhz` so two pilots dialing the same channel can collide and
 * a controller can't tune outside the rendered LCD range.
 */
export function normalizeRequestedFrequencyMhz(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9]{3}\.[0-9]{3}$/.test(trimmed)) return undefined;
  const mhzWhole = Number(trimmed.slice(0, 3));
  const fraction = Number(trimmed.slice(4));
  if (!Number.isFinite(mhzWhole) || !Number.isFinite(fraction)) return undefined;
  if (mhzWhole < 118 || mhzWhole > 136) return undefined;
  if (mhzWhole === 136 && fraction > 975) return undefined;
  if (fraction % 25 !== 0) return undefined;
  return trimmed;
}

/**
 * Backfill helper for SessionRecord values pulled from rows that pre-date the `name` /
 * `frequency_mhz` columns. Returns a copy of the record with both fields filled in from
 * the deterministic helpers if they're missing on the row. Lobby and create endpoints
 * route reads through this so the API surface NEVER returns a UUID-shaped fallback.
 */
export function withDerivedRoomLabels(record: SessionRecord): SessionRecord {
  const name = record.name ?? defaultRoomName(record.callsign ?? `PILOT-${record.id.slice(0, 3).toUpperCase()}`);
  const frequencyMhz = record.frequencyMhz ?? defaultFrequencyMhz(record.id);
  return { ...record, name, frequencyMhz };
}

function serverRadioPresetById(id: string): RadioQuickPreset | undefined {
  if (!SERVER_RADIO_PRESET_IDS.has(id)) return undefined;
  return RADIO_QUICK_PRESETS.find((preset) => preset.id === id);
}

function serverRadioPresetByFrequency(freq: string): RadioQuickPreset | undefined {
  const target = normalizeRequestedFrequencyMhz(freq);
  if (!target) return undefined;
  return RADIO_QUICK_PRESETS.find(
    (preset) => SERVER_RADIO_PRESET_IDS.has(preset.id) && preset.frequencyMhz === target
  );
}

function serverRadioSessionId(presetId: string): string {
  return `${SERVER_RADIO_SESSION_PREFIX}${presetId}`;
}

function serverRadioCallsign(preset: RadioQuickPreset): string {
  return `KSC-${preset.label}`;
}

export function isServerOwnedRadioSessionId(sessionId: string): boolean {
  if (!sessionId.startsWith(SERVER_RADIO_SESSION_PREFIX)) return false;
  return Boolean(serverRadioPresetById(sessionId.slice(SERVER_RADIO_SESSION_PREFIX.length)));
}

export function isServerOwnedRadioFrequency(freq: string): boolean {
  return Boolean(serverRadioPresetByFrequency(freq));
}

function isServerRadioOwner(userId: string | undefined): boolean {
  return userId === SERVER_RADIO_OWNER_USER_ID;
}

async function upsertServerRadioSession(preset: RadioQuickPreset): Promise<SessionRecord> {
  await ensureUser(SERVER_RADIO_OWNER_USER_ID);

  const id = serverRadioSessionId(preset.id);
  const name = SERVER_RADIO_ROOM_NAMES[preset.id] ?? `${preset.label} Radio`;
  const callsign = serverRadioCallsign(preset);
  const existing = await getSession(id);
  if (existing) {
    let changed = false;
    if (existing.status === "closed") {
      existing.status = "queued";
      changed = true;
    }
    if (existing.name !== name) {
      existing.name = name;
      changed = true;
    }
    if (existing.frequencyMhz !== preset.frequencyMhz) {
      existing.frequencyMhz = preset.frequencyMhz;
      changed = true;
    }
    if (!existing.callsign) {
      existing.callsign = callsign;
      changed = true;
    }
    if (!existing.squawk) {
      existing.squawk = "1200";
      changed = true;
    }
    if (changed) {
      existing.updatedAt = nowIso();
      localSessions.set(existing.id, existing);
      if (useDbPersistence()) {
        try {
          await withConn(async (conn) => {
            await conn.query(
              `
              UPDATE sessions
              SET status = ?,
                  callsign = ?,
                  squawk = ?,
                  name = ?,
                  frequency_mhz = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
              `,
              [existing.status, existing.callsign ?? callsign, existing.squawk ?? "1200", name, preset.frequencyMhz, id]
            );
          });
        } catch (error) {
          logger.warn({ err: error, sessionId: id }, "Failed to heal server radio session");
        }
      }
    }
    return existing;
  }

  const createdAt = nowIso();
  const record: SessionRecord = {
    id,
    pilotUserId: SERVER_RADIO_OWNER_USER_ID,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    blockedUserIds: [],
    spectatorUserIds: [],
    squawk: "1200",
    callsign,
    name,
    frequencyMhz: preset.frequencyMhz
  };

  localSessions.set(id, record);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO sessions (id, pilot_user_id, status, telemetry_json, blocked_users_json, squawk, callsign, name, frequency_mhz)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            status = IF(status = 'closed', VALUES(status), status),
            squawk = VALUES(squawk),
            callsign = VALUES(callsign),
            name = VALUES(name),
            frequency_mhz = VALUES(frequency_mhz),
            updated_at = CURRENT_TIMESTAMP
          `,
          [
            id,
            SERVER_RADIO_OWNER_USER_ID,
            "queued",
            null,
            JSON.stringify([]),
            "1200",
            callsign,
            name,
            preset.frequencyMhz
          ]
        );
      });
    } catch (error) {
      logger.warn({ err: error, sessionId: id }, "Failed to persist server radio session");
    }
  }

  return record;
}

export async function ensureServerRadioSessions(): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const preset of RADIO_QUICK_PRESETS) {
    if (!SERVER_RADIO_PRESET_IDS.has(preset.id)) continue;
    records.push(await upsertServerRadioSession(preset));
  }
  return records;
}

export async function getOrCreateServerRadioSessionByFrequency(
  freq: string
): Promise<SessionRecord | undefined> {
  const preset = serverRadioPresetByFrequency(freq);
  if (!preset) return undefined;
  return upsertServerRadioSession(preset);
}

/**
 * Trim + length-cap + control-char-strip the user-provided room name. Empty / whitespace-only
 * input collapses to undefined so the lobby falls back to `tower-{sessionId}`. The 80-char cap
 * matches the DB column (`VARCHAR(80)`); we deliberately keep it permissive on character set
 * (Unicode allowed) so users can name rooms in their own language — the UI just renders the
 * string directly without interpretation. See "Room name" in docs/GLOSSARY.md.
 */
export function sanitizeRoomName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Strip C0 control chars (incl. NUL/CR/LF) but keep regular printable text.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

/**
 * Given a desired base room name and a set of names already in use, return a
 * unique variant by appending ` 2`, ` 3`, ... when the base collides. Used so
 * KSP-launched pilots flying the same planet pack land in predictable names
 * ("KSP Stock", "KSP Stock 2", "KSP Stock 3") rather than UUID-shaped rooms,
 * without ever silently overwriting / merging into someone else's room.
 *
 * Comparison is case-insensitive but the returned string preserves the
 * caller's casing on the base. The numeric suffix is plain ASCII so it stays
 * 80-char-clean and copy/paste-safe in `settings.cfg`.
 */
export function disambiguateRoomName(base: string, takenNames: Iterable<string>): string {
  const taken = new Set<string>();
  for (const n of takenNames) {
    if (typeof n === "string" && n.length > 0) taken.add(n.toLowerCase());
  }
  const lowerBase = base.toLowerCase();
  if (!taken.has(lowerBase)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // 998 collisions on the same base name is functionally impossible in any
  // real deployment; fall back to a short suffix rather than spinning.
  return `${base} ${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Build a short, human-readable, URL-safe session id like `darren-a4f9` from the
 * pilot's display name (or email local-part / userId fallback) plus a 4-char hex
 * tail for collision avoidance. Lower-case + ascii only so it round-trips
 * through KSP `settings.cfg`, the IVA radio LCD, and the lobby card without
 * URL-encoding. Falls back to `pilot-XXXX` if every name source is empty.
 *
 * The tail is sized for ~65k unique slugs per callsign root, which is plenty
 * for any real session volume; if `attempt > 0` we re-roll the tail so the
 * caller can retry on a `localSessions` collision instead of giving up.
 *
 * NOTE: Replaces the previous `randomUUID()` id strategy. Existing UUID-shaped
 * rows still load fine because `getSession()` and the route layer both look up
 * sessions by string equality — there's no format check anywhere on the read
 * path. Users hated the UUIDs because they couldn't paste them into the
 * plugin's `sessionId` setting; this gives them a string they can actually
 * type.
 */
function generateSessionSlug(
  pilotUserId: string,
  displayName: string | undefined,
  attempt: number
): string {
  const candidates: string[] = [];
  if (displayName && displayName.trim().length > 0) {
    candidates.push(displayName.trim());
  }
  const configured = listConfiguredWebUsers().find((u) => u.userId === pilotUserId);
  if (configured?.email) {
    const at = configured.email.indexOf("@");
    candidates.push(at > 0 ? configured.email.slice(0, at) : configured.email);
  }
  candidates.push(pilotUserId);

  let root = "";
  for (const raw of candidates) {
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
    if (cleaned.length > 0) {
      root = cleaned;
      break;
    }
  }
  if (!root) root = "pilot";

  // 16-bit hex tail. Re-rolled per attempt so retry-on-collision actually moves.
  const tailNum = Math.floor(Math.random() * 0x10000);
  const tail = tailNum.toString(16).padStart(4, "0");
  // attempt is folded in as a salt so two simultaneous create calls with the
  // same Math.random seed (extremely rare, but possible under fake timers in
  // tests) still diverge on retry.
  const salted = attempt > 0 ? ((tailNum + attempt) & 0xffff).toString(16).padStart(4, "0") : tail;
  return `${root}-${salted}`;
}

export async function createSession(
  pilotUserId: string,
  opts: { name?: string; displayName?: string; frequencyMhz?: string } = {}
): Promise<SessionRecord> {
  await ensureUser(pilotUserId);
  // Pick a slug that doesn't collide with an existing in-memory session. DB
  // collisions are caught by the INSERT below and surfaced as an error; the
  // in-memory probe just keeps the common dev path quiet.
  let id = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateSessionSlug(pilotUserId, opts.displayName, attempt);
    if (!localSessions.has(candidate) && candidate !== DEV_SHARED_SESSION_ID) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    // 8 collisions in a row is ~1-in-10^32 with a 16-bit tail; if we hit it
    // something's badly wrong (e.g. Math.random replaced with a constant in
    // tests). Fall through to a UUID rather than spinning forever.
    id = randomUUID();
  }
  const createdAt = nowIso();
  const squawk = generateSquawk();
  const callsign = defaultCallsign(pilotUserId, id, opts.displayName);
  // Caller-supplied name wins; otherwise auto-derive a callsign-based English label so
  // the lobby never has to fall back to `tower-<UUID>`. Frequency is always auto-derived
  // (cosmetic only — see defaultFrequencyMhz).
  //
  // Disambiguation: when the caller supplied a name (typically the KSP plugin
  // sending its detected planet pack — "KSP Stock" / "JNSQ" / "RSS" / ...),
  // make sure we don't silently pick a name that's already in use by another
  // active session. `disambiguateRoomName` gives us "KSP Stock 2" / "KSP Stock 3"
  // etc. so two pilots launching the same planet pack get clearly-separate
  // rooms instead of confusing the lobby with two cards both labeled "KSP
  // Stock". Auto-derived callsign names are pilot-unique by construction (they
  // include the user's slug + squawk) so they don't need the same treatment.
  const requestedName = sanitizeRoomName(opts.name);
  let name: string;
  if (requestedName) {
    const taken: string[] = [];
    for (const s of localSessions.values()) {
      if (s.name) taken.push(s.name);
    }
    name = disambiguateRoomName(requestedName, taken);
  } else {
    name = defaultRoomName(callsign);
  }
  // Caller-supplied freq wins (validated to NNN.NNN inside the aviation VHF
  // band on 25 kHz spacing). Without this, dialing 122.000 in-game would mint
  // a room whose row is `frequency_mhz = 128.175` (a hash of the slug), and
  // the lobby card would render two different numbers — the human-set name
  // "122.000" and the hashed cosmetic "128.175 MHz" — for the same room.
  const requestedFreq = normalizeRequestedFrequencyMhz(opts.frequencyMhz);
  const frequencyMhz = requestedFreq ?? defaultFrequencyMhz(id);
  const record: SessionRecord = {
    id,
    pilotUserId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    blockedUserIds: [],
    spectatorUserIds: [],
    squawk,
    callsign,
    name,
    frequencyMhz
  };

  localSessions.set(id, record);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO sessions (id, pilot_user_id, status, telemetry_json, blocked_users_json, squawk, callsign, name, frequency_mhz)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [id, pilotUserId, "queued", null, JSON.stringify([]), squawk, callsign, name, frequencyMhz]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist session; using local fallback");
    }
  }

  return record;
}

/**
 * Rename a session's lobby room. Pass `name` as a string to set, or `null` / `undefined`
 * to clear it (UI then falls back to `tower-{sessionId}`). Returns the updated record or
 * `undefined` if the session doesn't exist. Sanitization is delegated to `sanitizeRoomName`,
 * which trims, strips control chars, and 80-char-caps. The auth gate (only the pilot or
 * an assigned controller / mod+ may rename) lives in the route handler.
 */
export async function setSessionName(
  sessionId: string,
  name: string | null | undefined
): Promise<SessionRecord | undefined> {
  const next = name == null ? undefined : sanitizeRoomName(name);

  const session = await getSession(sessionId);
  if (!session) return undefined;

  session.name = next;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `UPDATE sessions SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [next ?? null, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist session name");
    }
  }

  return session;
}

export async function getOrCreateDevSharedSession(pilotUserId: string): Promise<SessionRecord> {
  // The bridge is a non-human subscriber and must never be stamped as
  // pilotUserId / assignedTowerUserId on a session. The caller
  // (getSessionWithDevSharedBootstrap) gates this with `isBridgeIdentity` and
  // returns 404 to bridge tokens before we get here, but defend in depth.
  if (isBridgeIdentity(pilotUserId)) {
    throw new Error(
      `getOrCreateDevSharedSession refuses bridge identity '${pilotUserId}'; ` +
        "the dev-shared session must be created by a human pilot, not the voice bridge."
    );
  }
  await ensureUser(pilotUserId);
  const existing = localSessions.get(DEV_SHARED_SESSION_ID);
  if (existing) {
    // Heal a previously poisoned dev-shared row: if a bridge identity was the
    // first to hit /v1/session/dev-shared/livekit-token before this gate
    // existed, the row's pilot/tower were stamped as `ksp_bridge`. Reassign
    // to the first real human caller so the admin Users panel and session
    // bookkeeping stop showing the bridge as a player.
    let healed = false;
    if (isBridgeIdentity(existing.pilotUserId)) {
      existing.pilotUserId = pilotUserId;
      healed = true;
    }
    if (existing.assignedTowerUserId && isBridgeIdentity(existing.assignedTowerUserId)) {
      existing.assignedTowerUserId = pilotUserId;
      healed = true;
    }
    if (healed) {
      existing.updatedAt = nowIso();
      logger.warn(
        { sessionId: existing.id, newPilot: pilotUserId },
        "Healed dev-shared session previously stamped with a bridge identity as pilot/tower"
      );
      if (useDbPersistence()) {
        try {
          await withConn(async (conn) => {
            await conn.query(
              `UPDATE sessions SET pilot_user_id = ?, assigned_tower_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [existing.pilotUserId, existing.assignedTowerUserId ?? null, existing.id]
            );
          });
        } catch (error) {
          logger.warn({ err: error }, "Failed to persist dev-shared healing; in-memory copy is correct");
        }
      }
    }
    return existing;
  }

  const createdAt = nowIso();
  const record: SessionRecord = {
    id: DEV_SHARED_SESSION_ID,
    pilotUserId,
    status: "assigned",
    assignedTowerUserId: pilotUserId,
    createdAt,
    updatedAt: createdAt,
    blockedUserIds: [],
    spectatorUserIds: []
  };
  localSessions.set(record.id, record);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO sessions (id, pilot_user_id, assigned_tower_user_id, status, telemetry_json, blocked_users_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            assigned_tower_user_id = VALUES(assigned_tower_user_id),
            status = VALUES(status),
            updated_at = CURRENT_TIMESTAMP
          `,
          [record.id, record.pilotUserId, record.assignedTowerUserId, record.status, null, JSON.stringify([])]
        );
      });
    } catch {
      // local session is enough for dev mode
    }
  }

  return record;
}

export async function assignTower(sessionId: string, towerUserId: string): Promise<SessionRecord | undefined> {
  await ensureUser(towerUserId);
  const local = localSessions.get(sessionId);
  if (local) {
    local.assignedTowerUserId = towerUserId;
    local.status = "assigned";
    local.updatedAt = nowIso();
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET assigned_tower_user_id = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [towerUserId, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist tower assignment");
    }
  }

  return getSession(sessionId);
}

/**
 * Vacate the tower seat without rotating to a new controller. Mirrors
 * <c>store.clearAssignedTower</c> for the DB path; updates both the local
 * cache and the persisted row so the next listSessionsMerged() / getSession()
 * sees an empty seat.
 *
 * When `tryReplaceFromQueue` is true (the default for mod kicks and pilot
 * "give me a new tower" flows), this also runs `claimNextTowerForSession`
 * with the old tower excluded so a kick that happens while the queue has
 * waiting controllers gets a replacement assigned in the same write — no
 * stale "no tower assigned" frame for the lobby to render between calls.
 *
 * Returns the post-action session plus the user id that was released and the
 * id (if any) of the replacement controller pulled from the queue, so the API
 * layer can emit a useful audit log entry without a second round-trip.
 */
export async function clearAssignedTower(
  sessionId: string,
  opts: { tryReplaceFromQueue?: boolean } = {}
): Promise<{
  session: SessionRecord | undefined;
  releasedUserId: string | undefined;
  replacement: string | undefined;
}> {
  const before = await getSession(sessionId);
  if (!before) {
    return { session: undefined, releasedUserId: undefined, replacement: undefined };
  }

  const releasedUserId = before.assignedTowerUserId;
  if (!releasedUserId) {
    // Idempotent: another caller / a pagehide beacon race may have already
    // released the seat. Treat as success so the UI doesn't have to special-case.
    return { session: before, releasedUserId: undefined, replacement: undefined };
  }

  const local = localSessions.get(sessionId);
  if (local) {
    local.assignedTowerUserId = undefined;
    local.status = "queued";
    local.updatedAt = nowIso();
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET assigned_tower_user_id = NULL, status = 'queued', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error, sessionId }, "Failed to persist tower release");
    }
  }

  if (!opts.tryReplaceFromQueue) {
    return {
      session: await getSession(sessionId),
      releasedUserId,
      replacement: undefined
    };
  }

  // Excluding the just-released user prevents the queue from immediately
  // re-assigning the same person — a rotation, kick, or self-release should
  // always result in *somebody else* if a replacement exists.
  const excluded = new Set<string>([
    ...before.blockedUserIds,
    releasedUserId
  ]);
  const { session: claimed, assigned } = await claimNextTowerForSession(sessionId, excluded);
  return {
    session: claimed ?? (await getSession(sessionId)),
    releasedUserId,
    replacement: assigned
  };
}

export async function rotateNextTower(sessionId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;

  const previous = session.assignedTowerUserId;
  const excluded = new Set<string>([
    ...session.blockedUserIds,
    ...(previous ? [previous] : [])
  ]);

  const { session: claimed, assigned } = await claimNextTowerForSession(sessionId, excluded);
  if (!assigned) return claimed ?? session;

  // Put the previous tower back in the available pool so they can be claimed again
  // for a different session. Without this, a rotation would silently delist them.
  if (previous && previous !== assigned) {
    try {
      await joinTowerQueue(previous);
    } catch (error) {
      logger.warn({ err: error, previous }, "Failed to re-queue previous tower after rotation");
    }
  }

  return claimed;
}

export async function blockUserForSession(sessionId: string, blockedUserId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (!session.blockedUserIds.includes(blockedUserId)) {
    session.blockedUserIds.push(blockedUserId);
  }
  // Blocking a user implicitly evicts them from the spectator list — otherwise a
  // pilot could "block" someone and they'd silently keep listening to voice/chat.
  session.spectatorUserIds = session.spectatorUserIds.filter((id) => id !== blockedUserId);
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET blocked_users_json = ?, spectator_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [JSON.stringify(session.blockedUserIds), JSON.stringify(session.spectatorUserIds), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist block list");
    }
  }

  return session;
}

/**
 * Add a user to the spectator list (read-only listener). Idempotent: if the user
 * is already a spectator, the existing record is returned unchanged. Refuses to
 * add the pilot, the assigned controller, or anyone on the block list — those
 * cases are programming errors at the call site (the route handler should have
 * checked first), so we just no-op rather than corrupt the membership model.
 */
export async function addSessionSpectator(
  sessionId: string,
  spectatorUserId: string
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (session.pilotUserId === spectatorUserId) return session;
  if (session.assignedTowerUserId === spectatorUserId) return session;
  if (session.blockedUserIds.includes(spectatorUserId)) return session;
  if (session.spectatorUserIds.includes(spectatorUserId)) return session;

  session.spectatorUserIds.push(spectatorUserId);
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET spectator_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [JSON.stringify(session.spectatorUserIds), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist spectator add");
    }
  }

  return session;
}

/**
 * Remove a user from the spectator list. Idempotent — returns the session
 * unchanged if they weren't spectating. Doesn't touch pilot / controller fields
 * so calling this on the pilot's id is a safe no-op.
 */
export async function removeSessionSpectator(
  sessionId: string,
  spectatorUserId: string
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (!session.spectatorUserIds.includes(spectatorUserId)) return session;

  session.spectatorUserIds = session.spectatorUserIds.filter((id) => id !== spectatorUserId);
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET spectator_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [JSON.stringify(session.spectatorUserIds), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist spectator remove");
    }
  }

  return session;
}

/** Thrown by `setSessionPilot` when the target room exists but is closed. */
export class SessionClosedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} is closed`);
    this.name = "SessionClosedError";
  }
}

/**
 * Atomically swap the room's pilot to `newPilotUserId`. The previous pilot is
 * demoted to `spectatorUserIds` (so they keep their LiveKit subscribe and any
 * web-side desks they had open without a flicker) instead of being kicked out.
 *
 * Used by the in-game radio "tune to existing room" / `POST /v1/session/claim-pilot`
 * path: real radio is one-transmitter-per-channel, and the plugin caller is
 * physically flying the craft, so we don't preserve the prior pilot's seat —
 * we just keep them connected as a listener.
 *
 * Idempotent: calling with the existing pilot returns the session unchanged.
 * Throws `SessionClosedError` for closed rooms (route surfaces 410).
 */
export async function setSessionPilot(
  sessionId: string,
  newPilotUserId: string
): Promise<SessionRecord | undefined> {
  await ensureUser(newPilotUserId);
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (session.status === "closed") {
    throw new SessionClosedError(sessionId);
  }
  if (session.pilotUserId === newPilotUserId) {
    // Already pilot — also make sure they aren't accidentally listed as a
    // spectator of their own room (defensive; should never happen via the
    // normal route but cheap to enforce).
    if (session.spectatorUserIds.includes(newPilotUserId)) {
      session.spectatorUserIds = session.spectatorUserIds.filter((id) => id !== newPilotUserId);
      session.updatedAt = nowIso();
      localSessions.set(session.id, session);
      if (useDbPersistence()) {
        try {
          await withConn(async (conn) => {
            await conn.query(
              `UPDATE sessions SET spectator_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [JSON.stringify(session.spectatorUserIds), sessionId]
            );
          });
        } catch (error) {
          logger.warn({ err: error }, "Failed to dedupe spectator on pilot self-claim");
        }
      }
    }
    return session;
  }

  const priorPilotUserId = session.pilotUserId;
  // Demote prior pilot → spectator (unless they were already on the spectator
  // list somehow, or they ARE the new pilot which shouldn't happen given the
  // early-return above but defend against weird call sites).
  let nextSpectators = session.spectatorUserIds.filter((id) => id !== newPilotUserId);
  if (
    priorPilotUserId &&
    priorPilotUserId !== newPilotUserId &&
    !nextSpectators.includes(priorPilotUserId) &&
    !session.blockedUserIds.includes(priorPilotUserId) &&
    !isServerRadioOwner(priorPilotUserId)
  ) {
    nextSpectators = [...nextSpectators, priorPilotUserId];
  }

  session.pilotUserId = newPilotUserId;
  session.spectatorUserIds = nextSpectators;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET pilot_user_id = ?,
              spectator_user_ids_json = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [newPilotUserId, JSON.stringify(nextSpectators), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist pilot takeover");
    }
  }

  return session;
}

/**
 * Resolve a dialed frequency to one of the server-owned radio sessions. Unknown
 * frequencies deliberately return undefined; clients no longer mint arbitrary
 * rooms just because a pilot typed a valid MHz string.
 */
export async function findOpenSessionByFrequency(
  freq: string
): Promise<SessionRecord | undefined> {
  return getOrCreateServerRadioSessionByFrequency(freq);
}

/**
 * Mark a session as `closed`. The lobby card disappears (the room list filters
 * out closed rows) and `/v1/me/active-room` stops returning it for everyone —
 * pilot, controller, and spectators alike. The DB row is left intact so the
 * audit trail (chat, telemetry, scorecard) survives. Spectator list is wiped
 * since "spectating a closed room" has no meaning.
 */
export async function closeSession(sessionId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (session.status === "closed") return session;

  session.status = "closed";
  session.spectatorUserIds = [];
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET status = 'closed', spectator_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [JSON.stringify([]), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist session close");
    }
  }

  return session;
}

export async function setTelemetry(sessionId: string, telemetry: TelemetrySample): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const prevTelemetry = session.telemetry;
  const serverCs = session.callsign?.trim();
  const clientCs = telemetry.callsign?.trim();
  const merged: TelemetrySample = { ...telemetry };
  if (serverCs) merged.callsign = serverCs;
  else if (clientCs) merged.callsign = clientCs;
  else delete merged.callsign;
  session.telemetry = merged;
  session.radioState = updateRadioStateForTelemetry(sessionId, prevTelemetry, merged, session);
  session.lastTelemetryAt = nowIso();
  // Any fresh telemetry sample is an implicit "back to live" signal; clear the
  // last going-dark reason so the controller's banner disappears automatically
  // without the plugin needing a second "back online" round-trip.
  session.telemetryStatus = undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  publishLiveSnapshotEvent({ topic: "active-aircraft" });

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        UPDATE sessions
        SET telemetry_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
          [JSON.stringify(merged), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist telemetry");
    }
  }

  return session;
}

/**
 * Record a "going dark" reason pushed by the KSP plugin (beacon toggled off, exited
 * Flight scene, entered on-rails warp, vessel destroyed). Held only in memory: it is
 * inherently a live-stream signal that loses meaning across a backend restart and
 * we want a clean slate when the process bounces. Returns the updated session, or
 * `undefined` when the session doesn't exist.
 */
export async function setTelemetryStatus(
  sessionId: string,
  status: TelemetryStatusEvent
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.telemetryStatus = status;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  publishLiveSnapshotEvent({ topic: "active-aircraft" });
  return session;
}

export async function getSession(sessionId: string): Promise<SessionRecord | undefined> {
  const local = localSessions.get(sessionId);
  if (local) {
    return local;
  }

  if (!useDbPersistence()) {
    return undefined;
  }

  try {
    const session = await withConn(async (conn) => {
      const rows = (await conn.query(
        `
        SELECT id, pilot_user_id, assigned_tower_user_id, status, telemetry_json, blocked_users_json,
               spectator_user_ids_json,
               squawk, callsign, name, frequency_mhz, checklist_state, checklist_phases,
               countdown_starts_at, countdown_length_sec,
               clearances_json, expected_landing_runway,
               created_at, updated_at
        FROM sessions
        WHERE id = ?
        `,
        [sessionId]
      )) as Array<Record<string, unknown>>;
      if (!rows.length) return undefined;
      const first = rows[0];
      if (!first) return undefined;
      return mapSessionRow(first);
    });

    if (session) {
      localSessions.set(session.id, session);
      return session;
    }
  } catch {
    // Local fallback below.
  }

  return localSessions.get(sessionId);
}

/**
 * Resolve a session row, bootstrapping the shared dev session when missing (same policy as livekit-token / messages).
 * Prevents GET /v1/session/dev-shared 404 after the UI falls back from a room id with no telemetry yet.
 */
export async function getSessionWithDevSharedBootstrap(
  sessionId: string,
  actingUserId: string
): Promise<SessionRecord | undefined> {
  const existing = await getSession(sessionId);
  if (existing) {
    // Heal an already-existing dev-shared row that got poisoned by the bridge
    // before the gate below was added: if the row's pilot or tower is one of
    // the bridge identities, reassign it to the first real human caller.
    // Without this the admin Users panel keeps showing `ksp_bridge` as
    // pilot/tower forever even after the gate stops new poisoning.
    if (
      sessionId === DEV_SHARED_SESSION_ID &&
      !isBridgeIdentity(actingUserId) &&
      (isBridgeIdentity(existing.pilotUserId) ||
        (existing.assignedTowerUserId && isBridgeIdentity(existing.assignedTowerUserId)))
    ) {
      return getOrCreateDevSharedSession(actingUserId);
    }
    return existing;
  }
  if (
    sessionId === "dev-shared" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    env.DEV_OPEN_AUTH
  ) {
    // The KSP voice-bridge is not a player; it must not be the principal that
    // bootstraps the dev-shared session, or its identity gets stamped as
    // pilot/tower and pollutes the admin Users panel. Make the bridge wait
    // until a real human creates the row (the bridge already retries on 404).
    if (isBridgeIdentity(actingUserId)) {
      return undefined;
    }
    return getOrCreateDevSharedSession(actingUserId);
  }
  return undefined;
}

export async function addReport(record: Omit<ReportRecord, "id" | "createdAt">): Promise<ReportRecord> {
  const item: ReportRecord = {
    id: randomUUID(),
    createdAt: nowIso(),
    ...record
  };
  localReports.push(item);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        INSERT INTO reports (id, reporter_user_id, target_user_id, session_id, reason)
        VALUES (?, ?, ?, ?, ?)
        `,
          [item.id, item.reporterUserId, item.targetUserId ?? null, item.sessionId ?? null, item.reason]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist report");
    }
  }

  return item;
}

export async function listReports(): Promise<ReportRecord[]> {
  if (!useDbPersistence()) {
    return [...localReports].reverse();
  }

  try {
    const rows = await withConn(async (conn) => {
      return (await conn.query(
        `
        SELECT id, reporter_user_id, target_user_id, session_id, reason, created_at
        FROM reports
        ORDER BY created_at DESC
        LIMIT 500
        `
      )) as Array<Record<string, unknown>>;
    });

    return rows.map((row) => ({
      id: String(row.id),
      reporterUserId: String(row.reporter_user_id),
      targetUserId: row.target_user_id ? String(row.target_user_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      reason: String(row.reason),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));
  } catch {
    return [...localReports].reverse();
  }
}

export async function banUser(
  userId: string,
  bannedByUserId?: string,
  durationSeconds?: number,
  reason?: string
): Promise<void> {
  if (isOwnerImmuneId(userId)) {
    throw new Error("Cannot ban the immune owner principal");
  }
  const expiresAtMs = durationSeconds ? Date.now() + Math.max(1, durationSeconds) * 1000 : undefined;
  setLocalBan({ userId, kind: "ban", expiresAtMs, reason });
  localTowerQueue.delete(userId);
  try {
    const redis = getRedis();
    await redis.zrem(TOWER_QUEUE_KEY, userId);
  } catch {
    // ignore
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        INSERT INTO bans (user_id, banned_by_user_id, reason, kind, expires_at)
        VALUES (?, ?, ?, 'ban', ${expiresAtMs ? `FROM_UNIXTIME(? / 1000)` : `NULL`})
        ON DUPLICATE KEY UPDATE
          banned_by_user_id = VALUES(banned_by_user_id),
          reason = VALUES(reason),
          kind = VALUES(kind),
          expires_at = VALUES(expires_at)
        `,
          expiresAtMs
            ? [userId, bannedByUserId ?? null, reason ?? "manual admin ban", expiresAtMs]
            : [userId, bannedByUserId ?? null, reason ?? "manual admin ban"]
        );
        if (!expiresAtMs) {
          await conn.query(
            `UPDATE users SET is_banned = 1, updated_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ?`,
            [userId]
          );
        }
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist ban");
    }
  }
}

export interface BanListEntry {
  userId: string;
  kind: "ban" | "mute";
  ip?: string;
  expiresAt?: string;
  reason?: string;
}

/**
 * Lift a ban (or IP ban) for `userId`. Removes the in-memory record, deletes
 * the `bans` row of `kind='ban'`, and clears the `users.is_banned` flag set
 * by a permanent ban so the next `getUserAccess` call returns isBanned=false.
 *
 * Returns true if any record was actually removed; false means nothing was
 * active so the caller can surface "already lifted" instead of pretending.
 */
export async function unbanUser(targetUserId: string, actorUserId: string): Promise<boolean> {
  const localRemoved = clearLocalBan(targetUserId, "ban");
  let dbRemoved = false;
  if (useDbPersistence()) {
    try {
      dbRemoved = await withConn(async (conn) => {
        const result = (await conn.query(
          `DELETE FROM bans WHERE user_id = ? AND kind = 'ban'`,
          [targetUserId]
        )) as { affectedRows?: number };
        await conn.query(
          `UPDATE users SET is_banned = 0, updated_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ?`,
          [targetUserId]
        );
        return (result.affectedRows ?? 0) > 0;
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to delete ban row");
    }
  }
  const removed = localRemoved || dbRemoved;
  if (removed) {
    await logAction(actorUserId, "admin.unban", { targetUserId });
  }
  return removed;
}

/**
 * Lift an active mute. Mirrors `unbanUser` but keyed on `kind='mute'`. Does
 * not touch `users.is_banned` (mutes never set that flag). The caller is
 * responsible for restoring publish perms on the live SFU side via
 * `restorePublishForIdentity` — this only flips the persistence state.
 */
export async function unmuteUser(targetUserId: string, actorUserId: string): Promise<boolean> {
  const localRemoved = clearLocalBan(targetUserId, "mute");
  let dbRemoved = false;
  if (useDbPersistence()) {
    try {
      dbRemoved = await withConn(async (conn) => {
        const result = (await conn.query(
          `DELETE FROM bans WHERE user_id = ? AND kind = 'mute'`,
          [targetUserId]
        )) as { affectedRows?: number };
        return (result.affectedRows ?? 0) > 0;
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to delete mute row");
    }
  }
  const removed = localRemoved || dbRemoved;
  if (removed) {
    await logAction(actorUserId, "admin.unmute", { targetUserId });
  }
  return removed;
}

export async function listBans(): Promise<BanListEntry[]> {
  if (!useDbPersistence()) {
    const out: BanListEntry[] = [];
    for (const rec of iterLocalBans()) {
      if (!localBanIsActive(rec)) continue;
      out.push({
        userId: rec.userId,
        kind: rec.kind,
        ip: rec.ip,
        expiresAt: rec.expiresAtMs ? new Date(rec.expiresAtMs).toISOString() : undefined,
        reason: rec.reason
      });
    }
    return out;
  }

  try {
    const rows = await withConn(async (conn) => {
      return (await conn.query(
        `
        SELECT user_id, kind, ip, expires_at, reason
        FROM bans
        WHERE expires_at IS NULL OR expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1000
        `
      )) as Array<Record<string, unknown>>;
    });
    return rows.map((r) => ({
      userId: String(r.user_id),
      kind: (String(r.kind ?? "ban") as "ban" | "mute"),
      ip: r.ip ? String(r.ip) : undefined,
      expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : undefined,
      reason: r.reason ? String(r.reason) : undefined
    }));
  } catch {
    const out: BanListEntry[] = [];
    for (const rec of iterLocalBans()) {
      out.push({
        userId: rec.userId,
        kind: rec.kind,
        ip: rec.ip,
        expiresAt: rec.expiresAtMs ? new Date(rec.expiresAtMs).toISOString() : undefined,
        reason: rec.reason
      });
    }
    return out;
  }
}

/**
 * Read the operator-set display-name override for a user. Returns null when
 * the user has never renamed themselves; the caller should fall back to the
 * JWT-issued name (or the email local-part for legacy sessions).
 */
export function getDisplayNameOverride(userId: string): string | null {
  const v = localUserDisplayNames.get(userId);
  return v ? v : null;
}

/**
 * Set the user's display name. Persists to the registered-users JSON store
 * for self-registered accounts; for env-managed users and guests it lives
 * in-memory only (since their canonical record is owned by env/JWT).
 *
 * The caller is expected to have validated the input (length, char set) via
 * the route schema; this function only sanity-trims and persists.
 */
export async function setUserDisplayName(userId: string, displayName: string): Promise<void> {
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error("displayName is required");
  if (trimmed.length > 120) throw new Error("displayName too long");
  localUserDisplayNames.set(userId, trimmed);
  // Best-effort persist for self-registered users; env users and guests are
  // not in this store and will silently no-op (returns false).
  try {
    await setRegisteredUserDisplayName(userId, trimmed);
  } catch (err) {
    logger.warn({ err, userId }, "Failed to persist display name to registered-users store");
  }
}

/**
 * Per-user moderation history for the Settings page. Splits records into:
 *   - active: bans/mutes that are currently in force (from the live `bans` table)
 *   - past:   ban/mute/kick/ban-ip events recorded against this user in the
 *             action log (the bans table only keeps one row per (user_id, kind),
 *             so historical/expired actions only survive in `action_logs`)
 *
 * Each "past" entry includes the action name, when it happened, who issued
 * it, the duration (if any) and the reason — enough for a user to understand
 * what happened to their account without needing a mod to look it up.
 *
 * Counts and durations are derived from the metadata payload that
 * `/v1/admin/{ban,mute,kick,ban-ip}` already writes — see api.ts.
 */
export interface UserModerationActiveEntry {
  kind: "ban" | "mute";
  expiresAt?: string;
  reason?: string;
}

export interface UserModerationPastEntry {
  /** action_log row id, useful as a stable React key */
  id: string;
  /** ISO timestamp of when the moderator action ran */
  at: string;
  /** action_log action name (e.g. "admin.ban", "admin.mute", "admin.kick", "admin.banIp") */
  action: "admin.ban" | "admin.mute" | "admin.kick" | "admin.banIp";
  /** Moderator who issued the action (for transparency); may be empty for system actions */
  actorUserId: string;
  /** When the action was scheduled to expire, if it had a finite duration */
  expiresAt?: string;
  /** Duration in seconds at issuance time, if known */
  durationSeconds?: number;
  /** Reason supplied by the moderator (free text) */
  reason?: string;
  /** For kicks: the LiveKit room name they were dropped from */
  roomName?: string;
}

export interface UserModerationHistory {
  active: UserModerationActiveEntry[];
  past: UserModerationPastEntry[];
}

/**
 * Build the moderation history for a single user. Reads the active state from
 * `listBans` (already DB-or-local aware) and the historical state by scanning
 * the recent action-log window — enough to surface the user's most recent
 * incidents without paging through the entire archive.
 *
 * `historyLimit` caps the action_log scan window; defaults to 500 which is
 * what the admin Logs panel uses by convention.
 */
export async function listUserModerationHistory(
  userId: string,
  historyLimit = 500
): Promise<UserModerationHistory> {
  const allBans = await listBans();
  const active: UserModerationActiveEntry[] = allBans
    .filter((b) => b.userId === userId)
    .map((b) => ({ kind: b.kind, expiresAt: b.expiresAt, reason: b.reason }));

  const logs = await listLogs(historyLimit);
  const PAST_ACTIONS = new Set(["admin.ban", "admin.mute", "admin.kick", "admin.banIp"]);
  const past: UserModerationPastEntry[] = [];
  for (const row of logs) {
    if (!PAST_ACTIONS.has(row.action)) continue;
    const meta = row.metadata ?? {};
    // The ban / mute endpoints log `userId` as the *target*; banIp logs `guestId`;
    // kick logs `userId`. Match on any of those so a single guest_xxx user sees
    // the IP-ban that hit them too.
    const targetCandidates = [
      typeof meta.userId === "string" ? meta.userId : "",
      typeof meta.targetUserId === "string" ? meta.targetUserId : "",
      typeof meta.guestId === "string" ? meta.guestId : ""
    ];
    if (!targetCandidates.includes(userId)) continue;

    const durationSeconds =
      typeof meta.durationSeconds === "number"
        ? meta.durationSeconds
        : undefined;
    let expiresAt: string | undefined;
    if (typeof meta.expiresAtMs === "number" && Number.isFinite(meta.expiresAtMs)) {
      expiresAt = new Date(meta.expiresAtMs).toISOString();
    } else if (durationSeconds && Number.isFinite(durationSeconds)) {
      expiresAt = new Date(Date.parse(row.at) + durationSeconds * 1000).toISOString();
    }
    const reason =
      typeof meta.reason === "string" && meta.reason.length > 0 ? meta.reason : undefined;
    const roomName = typeof meta.roomName === "string" ? meta.roomName : undefined;

    past.push({
      id: row.id,
      at: row.at,
      action: row.action as UserModerationPastEntry["action"],
      actorUserId: row.actorUserId,
      expiresAt,
      durationSeconds,
      reason,
      roomName
    });
  }

  return { active, past };
}

export async function logAction(actorUserId: string, action: string, metadata?: Record<string, unknown>): Promise<void> {
  const row: ActionLogRecord = {
    id: randomUUID(),
    at: nowIso(),
    actorUserId,
    action,
    metadata
  };
  localLogs.push(row);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
        INSERT INTO action_logs (id, actor_user_id, action_name, metadata_json)
        VALUES (?, ?, ?, ?)
        `,
          [row.id, actorUserId, action, metadata ? JSON.stringify(metadata) : null]
        );
      });
    } catch {
      // ignore database log failures
    }
  }
}

export async function appendSessionMessage(
  sessionId: string,
  fromUserId: string,
  body: string
): Promise<SessionMessage> {
  const trimmed = body.slice(0, 4000);
  const msg: SessionMessage = {
    id: randomUUID(),
    sessionId,
    fromUserId,
    body: trimmed,
    createdAt: nowIso()
  };

  const list = localSessionMessages.get(sessionId) ?? [];
  list.push(msg);
  // Cap per-session memory to defeat an attacker who has already gotten past
  // the rate limiter (e.g. via multiple accounts). Drop the oldest first.
  if (list.length > SESSION_MESSAGE_MEMORY_CAP) {
    list.splice(0, list.length - SESSION_MESSAGE_MEMORY_CAP);
  }
  localSessionMessages.set(sessionId, list);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO session_messages (id, session_id, from_user_id, body)
          VALUES (?, ?, ?, ?)
          `,
          [msg.id, sessionId, fromUserId, trimmed]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist session message");
    }
  }

  publishLiveSnapshotEvent({ topic: "session-messages", sessionId, deltaMessageId: msg.id });
  return msg;
}

export async function listSessionMessages(sessionId: string, sinceIso?: string): Promise<SessionMessage[]> {
  if (!useDbPersistence()) {
    const list = localSessionMessages.get(sessionId) ?? [];
    if (!sinceIso) {
      return list.slice(-200);
    }
    const since = Date.parse(sinceIso);
    return list.filter((m) => Date.parse(m.createdAt) > since);
  }

  try {
    const rows = await withConn(async (conn) => {
      if (sinceIso) {
        return (await conn.query(
          `
          SELECT id, session_id, from_user_id, body, created_at
          FROM session_messages
          WHERE session_id = ? AND created_at > ?
          ORDER BY created_at ASC
          LIMIT 500
          `,
          [sessionId, sinceIso]
        )) as Array<Record<string, unknown>>;
      }
      return (await conn.query(
        `
        SELECT id, session_id, from_user_id, body, created_at
        FROM session_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 200
        `,
        [sessionId]
      )) as Array<Record<string, unknown>>;
    });

    const mapped = rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      fromUserId: String(row.from_user_id),
      body: String(row.body),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));

    if (!sinceIso) {
      mapped.reverse();
    }
    return mapped;
  } catch (error) {
    logger.warn({ err: error }, "listSessionMessages DB failed; using local store");
    const list = localSessionMessages.get(sessionId) ?? [];
    if (!sinceIso) {
      return list.slice(-200);
    }
    const since = Date.parse(sinceIso);
    return list.filter((m) => Date.parse(m.createdAt) > since);
  }
}

// ─── kOS screen mirror ────────────────────────────────────────────────────────
// One-way pipe from in-game kOS terminals (TowerKosScreenAutoCapture walks
// every kOSProcessor and POSTs each changed terminal line) to the web
// KosScreenPanel. Stored separately from session_messages so the chat/ACARS
// feed stays clean and so we can keep a tighter ring (high-rate script output
// should not push real chat off-screen).

export interface KosScreenLine {
  id: string;
  sessionId: string;
  fromUserId: string;
  body: string;
  createdAt: string;
}

const localKosScreenLines = new Map<string, KosScreenLine[]>();

/**
 * Per-session in-memory ring for kOS screen output. Smaller than the chat cap
 * because scripts can flood (a tight loop of `SCREEN("foo")` plus the rate
 * limiter still lets ~1 line/sec through per session). The DB holds full
 * history when persistence is on; this only protects the in-memory fallback.
 */
const KOS_SCREEN_MEMORY_CAP = 500;

export async function appendKosScreenLine(
  sessionId: string,
  fromUserId: string,
  body: string
): Promise<KosScreenLine> {
  const trimmed = body.slice(0, 4000);
  const line: KosScreenLine = {
    id: randomUUID(),
    sessionId,
    fromUserId,
    body: trimmed,
    createdAt: nowIso()
  };

  const list = localKosScreenLines.get(sessionId) ?? [];
  list.push(line);
  if (list.length > KOS_SCREEN_MEMORY_CAP) {
    list.splice(0, list.length - KOS_SCREEN_MEMORY_CAP);
  }
  localKosScreenLines.set(sessionId, list);

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          INSERT INTO session_kos_screen (id, session_id, from_user_id, body)
          VALUES (?, ?, ?, ?)
          `,
          [line.id, sessionId, fromUserId, trimmed]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist kOS screen line");
    }
  }

  return line;
}

export async function listKosScreenLines(
  sessionId: string,
  sinceIso?: string
): Promise<KosScreenLine[]> {
  if (!useDbPersistence()) {
    const list = localKosScreenLines.get(sessionId) ?? [];
    if (!sinceIso) {
      return list.slice(-200);
    }
    const since = Date.parse(sinceIso);
    return list.filter((m) => Date.parse(m.createdAt) > since);
  }

  try {
    const rows = await withConn(async (conn) => {
      if (sinceIso) {
        return (await conn.query(
          `
          SELECT id, session_id, from_user_id, body, created_at
          FROM session_kos_screen
          WHERE session_id = ? AND created_at > ?
          ORDER BY created_at ASC
          LIMIT 500
          `,
          [sessionId, sinceIso]
        )) as Array<Record<string, unknown>>;
      }
      return (await conn.query(
        `
        SELECT id, session_id, from_user_id, body, created_at
        FROM session_kos_screen
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 200
        `,
        [sessionId]
      )) as Array<Record<string, unknown>>;
    });

    const mapped = rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      fromUserId: String(row.from_user_id),
      body: String(row.body),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));

    if (!sinceIso) {
      mapped.reverse();
    }
    return mapped;
  } catch (error) {
    logger.warn({ err: error }, "listKosScreenLines DB failed; using local store");
    const list = localKosScreenLines.get(sessionId) ?? [];
    if (!sinceIso) {
      return list.slice(-200);
    }
    const since = Date.parse(sinceIso);
    return list.filter((m) => Date.parse(m.createdAt) > since);
  }
}

export async function appendLobbyMessage(fromUserId: string, body: string): Promise<SessionMessage> {
  return appendSessionMessage(LOBBY_SESSION_ID, fromUserId, body);
}

export async function listLobbyMessages(sinceIso?: string): Promise<SessionMessage[]> {
  return listSessionMessages(LOBBY_SESSION_ID, sinceIso);
}

// ─── Booth (spectator) channel ────────────────────────────────────────────────
// The booth is the per-session commentary channel that runs in parallel to the
// ops channel: spectators chatter freely, the assigned tower controller is the
// only seat present in BOTH channels, and the pilot never sees / hears the
// booth at all. To avoid a schema migration we reuse the existing
// `session_messages` table for booth chat, keyed off a synthetic thread id
// `booth:<sessionId>`. The booth voice room is `tower-<sessionId>-booth`,
// minted on demand by the LiveKit room helper.

const BOOTH_THREAD_PREFIX = "booth:";
const BOOTH_LIVEKIT_ROOM_SUFFIX = "-booth";

/** Synthetic chat thread id for the booth channel of `sessionId`. */
export function boothThreadId(sessionId: string): string {
  if (!sessionId) {
    throw new Error("boothThreadId: sessionId is required");
  }
  return `${BOOTH_THREAD_PREFIX}${sessionId}`;
}

/** True when `id` is a booth chat thread id (e.g. `booth:9d1e…`). */
export function isBoothThreadId(id: string): boolean {
  return typeof id === "string" && id.startsWith(BOOTH_THREAD_PREFIX);
}

/** LiveKit room name for the booth voice room of `sessionId`. */
export function boothLiveKitRoomName(sessionId: string): string {
  return `tower-${sessionId}${BOOTH_LIVEKIT_ROOM_SUFFIX}`;
}

/** LiveKit room name for the ops voice room of `sessionId` (the existing one). */
export function opsLiveKitRoomName(sessionId: string): string {
  if (isServerOwnedRadioSessionId(sessionId)) {
    return SERVER_RADIO_SHARED_OPS_ROOM;
  }
  return `tower-${sessionId}`;
}

/** Read the booth kill-switch state for a session; defaults to false. */
export function getSessionBoothMuted(session: SessionRecord | undefined | null): boolean {
  return Boolean(session?.boothMuted);
}

/**
 * Toggle the booth kill-switch for a session. Stored only in `localSessions`
 * (the DB schema has no column for this — an ephemeral moderation flag that
 * implicitly clears on backend restart is the intended behavior). Returns the
 * updated session, or `undefined` if the session doesn't exist.
 */
export async function setSessionBoothMuted(
  sessionId: string,
  muted: boolean
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.boothMuted = muted;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  return session;
}

function dragonRadarSeedFrom(sessionId: string, bodyName: string): number {
  const src = `${sessionId}|${bodyName}`;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function makeDragonRadarRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967295;
  };
}

function normalizeDragonBodyName(raw: unknown): string {
  const body = typeof raw === "string" ? raw.trim() : "";
  return body.length > 0 ? body.slice(0, 64) : "Kerbin";
}

function bodyRadiusM(bodyName: string): number {
  switch ((bodyName || "").trim().toLowerCase()) {
    case "kerbin":
      return 600_000;
    case "mun":
      return 200_000;
    case "minmus":
      return 60_000;
    case "duna":
      return 320_000;
    case "ike":
      return 130_000;
    case "eve":
      return 700_000;
    case "gilly":
      return 13_000;
    case "dres":
      return 138_000;
    case "jool":
      return 6_000_000;
    case "laythe":
      return 500_000;
    case "vall":
      return 300_000;
    case "tylo":
      return 600_000;
    case "bop":
      return 65_000;
    case "pol":
      return 44_000;
    case "eeloo":
      return 210_000;
    case "moho":
      return 250_000;
    default:
      return 600_000;
  }
}

function greatCircleMeters(
  lat0: number,
  lon0: number,
  lat1: number,
  lon1: number,
  radiusM: number
): number {
  const dLat = ((lat1 - lat0) * Math.PI) / 180;
  const dLon = ((lon1 - lon0) * Math.PI) / 180;
  const p0 = (lat0 * Math.PI) / 180;
  const p1 = (lat1 * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p0) * Math.cos(p1) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * radiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type TelemetryPosition = {
  bodyName: string;
  lat: number;
  lon: number;
  aslAlt: number;
};

function telemetryPositionOf(session: SessionRecord | undefined): TelemetryPosition | undefined {
  const t = session?.telemetry;
  if (!t) return undefined;
  if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) return undefined;
  return {
    bodyName: normalizeDragonBodyName(t.bodyName),
    lat: Number(t.lat),
    lon: Number(t.lon),
    aslAlt: Number.isFinite(t.aslAlt) ? Number(t.aslAlt) : 0
  };
}

/** KSP `Vessel.Situations` string from plugin telemetry — must be on the ground to claim a ball. */
function isDragonRadarPilotLanded(t: TelemetrySample | undefined): boolean {
  if (!t?.situation) return false;
  const s = String(t.situation).trim().toUpperCase();
  return s === "LANDED" || s === "SPLASHED";
}

function createDragonRadarBalls(sessionId: string, bodyName: string): DragonRadarBallState[] {
  const rng = makeDragonRadarRng(dragonRadarSeedFrom(sessionId, bodyName));
  const balls: DragonRadarBallState[] = [];
  for (let i = 0; i < 7; i++) {
    const lat = rng() * 120 - 60;
    const lon = rng() * 360 - 180;
    const aslAlt = Math.round(rng() * 1800);
    balls.push({
      id: `ball-${i + 1}`,
      bodyName,
      lat,
      lon,
      aslAlt
    });
  }
  return balls;
}

export function getDragonRadarRules(): DragonRadarRules {
  return DRAGON_RADAR_RULES;
}

function countDragonBallsHeldBySession(game: DragonRadarGameState, winnerSessionId: string): number {
  const w = winnerSessionId.trim();
  if (!w || !game.balls || game.balls.length === 0) return 0;
  let n = 0;
  for (const b of game.balls) {
    const car = (b.carrierSessionId ?? "").trim();
    const col = (b.collectedBySessionId ?? "").trim();
    if (car === w || col === w) n++;
  }
  return n;
}

function maybeAwardDragonRadarCrewRevive(session: SessionRecord, game: DragonRadarGameState, winnerSessionId: string): void {
  if (game.crewReviveOffer?.offeredAt) return;
  if (!game.balls || game.balls.length < 7) return;
  if (countDragonBallsHeldBySession(game, winnerSessionId) < 7) return;

  const w = winnerSessionId.trim();
  game.crewReviveOffer = { offeredAt: nowIso(), targetSessionId: w };
  game.version += 1;
  game.updatedAt = nowIso();
  session.updatedAt = game.updatedAt;
  localSessions.set(session.id, session);
  void appendSessionMessage(
    session.id,
    "system",
    "[DRAGON RADAR] All seven balls are with this room — grant the crew-restore wish from in-game RAD (one-time per game)."
  ).catch(() => undefined);
}

export async function acknowledgeSessionDragonRadarCrewRevive(
  sessionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const session = await getSession(sessionId);
  if (!session?.dragonRadarGame?.crewReviveOffer) {
    return { ok: false, reason: "no_offer" };
  }
  const offer = session.dragonRadarGame.crewReviveOffer;
  if (offer.consumedAt) {
    return { ok: false, reason: "already_consumed" };
  }
  const target = (offer.targetSessionId ?? "").trim();
  if (target !== sessionId.trim()) {
    return { ok: false, reason: "wrong_session" };
  }
  offer.consumedAt = nowIso();
  session.dragonRadarGame.version += 1;
  session.dragonRadarGame.updatedAt = nowIso();
  session.updatedAt = session.dragonRadarGame.updatedAt;
  localSessions.set(session.id, session);
  return { ok: true };
}

export async function getSessionDragonRadarGame(
  sessionId: string
): Promise<DragonRadarGameState | undefined> {
  const session = await getSession(sessionId);
  return session?.dragonRadarGame;
}

export async function startSessionDragonRadarGame(
  sessionId: string,
  input: { bodyName?: string; startedBy: string }
): Promise<DragonRadarGameState | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;

  const telemBody = normalizeDragonBodyName(session.telemetry?.bodyName);
  const bodyName = normalizeDragonBodyName(input.bodyName || telemBody);
  const now = nowIso();
  session.dragonRadarGame = {
    gameId: randomUUID(),
    bodyName,
    startedAt: now,
    startedBy: input.startedBy,
    updatedAt: now,
    version: 1,
    balls: createDragonRadarBalls(sessionId, bodyName)
  };
  session.updatedAt = now;
  localSessions.set(session.id, session);
  return session.dragonRadarGame;
}

export async function claimSessionDragonBall(
  sessionId: string,
  input: { ballId: string }
): Promise<{ state: DragonRadarGameState; claimed: boolean; reason?: string } | undefined> {
  const session = await getSession(sessionId);
  if (!session || !session.dragonRadarGame) return undefined;
  const game = session.dragonRadarGame;
  const ball = game.balls.find((b) => b.id === input.ballId);
  if (!ball) return { state: game, claimed: false, reason: "ball_not_found" };
  if (ball.carrierSessionId || ball.collectedBySessionId) {
    return { state: game, claimed: false, reason: "already_carried" };
  }

  const pos = telemetryPositionOf(session);
  if (!pos) {
    return { state: game, claimed: false, reason: "no_telemetry" };
  }
  if (pos.bodyName.toLowerCase() !== ball.bodyName.toLowerCase()) {
    return { state: game, claimed: false, reason: "wrong_body" };
  }

  if (!isDragonRadarPilotLanded(session.telemetry)) {
    return { state: game, claimed: false, reason: "not_landed" };
  }

  const surfaceM = greatCircleMeters(pos.lat, pos.lon, ball.lat, ball.lon, bodyRadiusM(ball.bodyName));
  if (surfaceM > DRAGON_RADAR_RULES.claimRadiusM) {
    return { state: game, claimed: false, reason: "too_far" };
  }

  ball.carrierSessionId = sessionId;
  game.version += 1;
  game.updatedAt = nowIso();
  session.updatedAt = game.updatedAt;
  localSessions.set(session.id, session);
  maybeAwardDragonRadarCrewRevive(session, game, sessionId);
  return { state: game, claimed: true };
}

export async function resolveSessionDragonRadarCombat(
  sessionId: string,
  input: { victimSessionId: string; kind: DragonRadarCombatKind }
): Promise<{ state: DragonRadarGameState; movedBalls: number } | undefined> {
  const session = await getSession(sessionId);
  if (!session || !session.dragonRadarGame) return undefined;
  const game = session.dragonRadarGame;
  const victimPos = telemetryPositionOf(await getSession(input.victimSessionId));
  let moved = 0;
  for (const b of game.balls) {
    if (b.carrierSessionId !== input.victimSessionId) continue;
    moved += 1;
    if (input.kind === "kill") {
      b.carrierSessionId = sessionId;
      continue;
    }

    // Hit: victim drops the ball near their latest pose.
    b.carrierSessionId = undefined;
    if (victimPos && victimPos.bodyName.toLowerCase() === b.bodyName.toLowerCase()) {
      b.lat = victimPos.lat;
      b.lon = victimPos.lon;
      b.aslAlt = Math.max(0, victimPos.aslAlt);
    }
  }
  if (moved > 0) {
    game.lastCombat = {
      at: nowIso(),
      attackerSessionId: sessionId,
      victimSessionId: input.victimSessionId,
      kind: input.kind,
      movedBalls: moved
    };
    game.version += 1;
    game.updatedAt = nowIso();
    session.updatedAt = game.updatedAt;
    localSessions.set(session.id, session);
    maybeAwardDragonRadarCrewRevive(session, game, sessionId);
  }
  return { state: game, movedBalls: moved };
}

/**
 * Append a shared waypoint to the session's in-memory list. Returns the updated
 * session and the newly-created waypoint (so the route can echo the assigned id
 * back to the client without a second `getSession` round-trip).
 *
 * Drops the oldest waypoint when the cap is hit (FIFO) instead of refusing the
 * write — the cap exists to bound memory, not to be a UX surface. Callers are
 * the route handler `POST /v1/session/:id/waypoints`; the only authn is the
 * standard `loadSessionIfAuthorized` membership check, identical to chat.
 */
export async function addSessionSharedWaypoint(
  sessionId: string,
  input: { bodyName: string; lat: number; lon: number; label?: string; color?: string },
  createdBy: string
): Promise<{ session: SessionRecord; waypoint: SharedWaypoint } | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const list = (session.sharedWaypoints ?? []).slice();
  while (list.length >= MAX_SESSION_SHARED_WAYPOINTS) {
    list.shift();
  }
  const waypoint: SharedWaypoint = {
    id: randomUUID(),
    bodyName: input.bodyName,
    lat: input.lat,
    lon: input.lon,
    ...(input.label != null ? { label: input.label } : {}),
    ...(input.color != null ? { color: input.color } : {}),
    createdAt: nowIso(),
    createdBy
  };
  list.push(waypoint);
  session.sharedWaypoints = list;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  return { session, waypoint };
}

/**
 * Remove one shared waypoint by id. Returns the updated session (waypoint
 * either gone or was never there). Idempotent — re-deleting an already-gone id
 * is a no-op so DELETE retries from a flaky network don't 404.
 */
export async function removeSessionSharedWaypoint(
  sessionId: string,
  waypointId: string
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const list = session.sharedWaypoints ?? [];
  const next = list.filter((w) => w.id !== waypointId);
  if (next.length !== list.length) {
    session.sharedWaypoints = next;
    session.updatedAt = nowIso();
    localSessions.set(session.id, session);
  }
  return session;
}

// ─── Direct messages ───────────────────────────────────────────────────────────
// DMs reuse the existing `session_messages` table so we don't need a new schema
// or a new in-memory store. A 1:1 thread between A and B is keyed by a synthetic
// session id of the form `dm:<lo>|<hi>` where <lo>/<hi> are the participant
// userIds in lexicographic order. Sorting makes the key symmetric (A→B and
// B→A both resolve to the same thread) and avoids two parallel rows for one
// conversation. The `dm:` prefix also lets `listChatRoomSummariesAdmin` and the
// admin chat-rooms view filter DMs out cleanly without needing a new column.

const DM_SESSION_PREFIX = "dm:";

/** Produce the synthetic session id for the DM thread between two users. Symmetric in its arguments. */
export function dmThreadId(userIdA: string, userIdB: string): string {
  if (!userIdA || !userIdB) {
    throw new Error("dmThreadId: both userIds are required");
  }
  if (userIdA === userIdB) {
    throw new Error("dmThreadId: cannot create a DM thread with yourself");
  }
  const [lo, hi] = userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
  // The userIds in this codebase are JWT subjects (no `|` characters); using
  // `|` as a separator avoids collision with `:` from prefixes like `guest_`.
  return `${DM_SESSION_PREFIX}${lo}|${hi}`;
}

/** Returns the two participants if `id` is a DM thread id, or null otherwise. */
export function parseDmThreadId(id: string): { lo: string; hi: string } | null {
  if (!id || !id.startsWith(DM_SESSION_PREFIX)) {
    return null;
  }
  const rest = id.slice(DM_SESSION_PREFIX.length);
  const sep = rest.indexOf("|");
  if (sep <= 0 || sep === rest.length - 1) {
    return null;
  }
  return { lo: rest.slice(0, sep), hi: rest.slice(sep + 1) };
}

/** True when `userId` is one of the two participants on the DM thread. */
export function isDmParticipant(threadId: string, userId: string): boolean {
  const parts = parseDmThreadId(threadId);
  if (!parts) return false;
  return parts.lo === userId || parts.hi === userId;
}

export async function appendDirectMessage(
  fromUserId: string,
  toUserId: string,
  body: string
): Promise<SessionMessage> {
  const threadId = dmThreadId(fromUserId, toUserId);
  return appendSessionMessage(threadId, fromUserId, body);
}

export async function listDirectMessages(
  forUserId: string,
  peerUserId: string,
  sinceIso?: string
): Promise<SessionMessage[]> {
  const threadId = dmThreadId(forUserId, peerUserId);
  return listSessionMessages(threadId, sinceIso);
}

export interface DirectMessageThreadSummary {
  /** The other participant's userId. */
  peerUserId: string;
  /** The most recent message in the thread (any direction), if any. */
  lastMessage?: SessionMessage;
}

/**
 * Returns every DM thread `forUserId` is a participant on, newest activity first.
 * Pulls from both the in-memory map and (when DB persistence is enabled) the
 * `session_messages` table — DM threads survive a restart the same way session
 * chat does.
 */
export async function listDirectMessageThreads(
  forUserId: string
): Promise<DirectMessageThreadSummary[]> {
  const lastByPeer = new Map<string, SessionMessage>();

  function consider(msg: SessionMessage, peerUserId: string): void {
    const prev = lastByPeer.get(peerUserId);
    if (!prev || prev.createdAt < msg.createdAt) {
      lastByPeer.set(peerUserId, msg);
    }
  }

  for (const [sessionId, msgs] of localSessionMessages.entries()) {
    const parts = parseDmThreadId(sessionId);
    if (!parts) continue;
    if (parts.lo !== forUserId && parts.hi !== forUserId) continue;
    if (msgs.length === 0) continue;
    const peerUserId = parts.lo === forUserId ? parts.hi : parts.lo;
    consider(msgs[msgs.length - 1]!, peerUserId);
  }

  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) => {
        // Pull thread heads via a window-style query: for each `session_id`,
        // grab the most recent row. We can't `LIMIT` per group portably, so
        // rely on the small index on (session_id, created_at) and aggregate
        // in code. For very large deployments this should move to a join on
        // a derived `MAX(created_at) GROUP BY session_id` subquery.
        return (await conn.query(
          `
          SELECT id, session_id, from_user_id, body, created_at
          FROM session_messages
          WHERE session_id LIKE ?
            AND (session_id LIKE ? OR session_id LIKE ?)
          ORDER BY created_at DESC
          LIMIT 2000
          `,
          [
            `${DM_SESSION_PREFIX}%`,
            `${DM_SESSION_PREFIX}${forUserId}|%`,
            `${DM_SESSION_PREFIX}%|${forUserId}`
          ]
        )) as Array<Record<string, unknown>>;
      });

      for (const row of rows) {
        const sessionId = String(row.session_id);
        const parts = parseDmThreadId(sessionId);
        if (!parts) continue;
        if (parts.lo !== forUserId && parts.hi !== forUserId) continue;
        const peerUserId = parts.lo === forUserId ? parts.hi : parts.lo;
        const msg: SessionMessage = {
          id: String(row.id),
          sessionId,
          fromUserId: String(row.from_user_id),
          body: String(row.body),
          createdAt: new Date(String(row.created_at)).toISOString()
        };
        consider(msg, peerUserId);
      }
    } catch (error) {
      logger.warn({ err: error }, "listDirectMessageThreads DB scan failed; in-memory only");
    }
  }

  const result: DirectMessageThreadSummary[] = [];
  for (const [peerUserId, lastMessage] of lastByPeer.entries()) {
    result.push({ peerUserId, lastMessage });
  }
  result.sort((a, b) => {
    const ta = a.lastMessage?.createdAt ?? "";
    const tb = b.lastMessage?.createdAt ?? "";
    return tb.localeCompare(ta);
  });
  return result;
}

export interface DirectMessagePeer {
  userId: string;
  /** Resolved display name (email local-part fallback). */
  displayName: string;
  /** Email if known (configured web users only). Useful for picker tooltips. */
  email?: string;
  /** Static role from configuration; absent for users learned from chat history. */
  role?: Role;
}

/**
 * User ids in the same non-closed tower session as `forUserId` (pilot, assigned
 * controller, spectators) so DMs work between people who only meet in a room
 * and never appear together in `WEB_LOGIN_USERS_JSON`.
 */
export function coParticipantUserIdsFromSessions(forUserId: string, sessions: SessionRecord[]): string[] {
  const out = new Set<string>();
  for (const s of sessions) {
    if (s.status === "closed") continue;
    const isMember =
      s.pilotUserId === forUserId ||
      s.assignedTowerUserId === forUserId ||
      s.spectatorUserIds.includes(forUserId);
    if (!isMember) continue;
    if (s.pilotUserId && s.pilotUserId !== forUserId && !isServerRadioOwner(s.pilotUserId)) {
      out.add(s.pilotUserId);
    }
    if (
      s.assignedTowerUserId &&
      s.assignedTowerUserId !== forUserId &&
      !isServerRadioOwner(s.assignedTowerUserId)
    ) {
      out.add(s.assignedTowerUserId);
    }
    for (const sp of s.spectatorUserIds) {
      if (sp !== forUserId && !isServerRadioOwner(sp)) {
        out.add(sp);
      }
    }
  }
  return Array.from(out);
}

/**
 * The list of users the caller is allowed to start a DM with. Today this is
 * every configured web user (minus the caller themselves) plus anyone the
 * caller already has an open DM thread with — that way reply-to-an-unfamiliar-
 * sender keeps working even if the peer was added to the user list later, and
 * it also keeps in-flight DMs from disappearing if a config entry is removed.
 * Also includes anyone sharing a live tower session (pilot / controller /
 * spectators) so cockpit ↔ tower DMs are addressable without pre-seeding env
 * user lists.
 *
 * When MariaDB is available, every other non-banned row in `users` (Clerk
 * subjects created via ensureUser) is listed too so hosted stacks with Clerk
 * (no WEB_LOGIN_USERS_JSON directory) still get a working peer picker.
 *
 * Guests (`guest_*`) are intentionally excluded. They can't authenticate to
 * read a DM addressed to them after their token expires, so listing them as a
 * picker option would be misleading.
 */
export async function listDirectMessagePeers(forUserId: string): Promise<DirectMessagePeer[]> {
  const byId = new Map<string, DirectMessagePeer>();

  for (const u of listConfiguredWebUsers()) {
    if (u.userId === forUserId) continue;
    if (isGuestId(u.userId)) continue;
    byId.set(u.userId, {
      userId: u.userId,
      displayName: deriveDisplayName(u.email, u.userId),
      email: u.email,
      role: u.role
    });
  }

  const threads = await listDirectMessageThreads(forUserId);
  for (const t of threads) {
    if (byId.has(t.peerUserId)) continue;
    if (isGuestId(t.peerUserId)) continue;
    byId.set(t.peerUserId, {
      userId: t.peerUserId,
      displayName: t.peerUserId
    });
  }

  const sessions = await listSessionsMerged();
  for (const peerId of coParticipantUserIdsFromSessions(forUserId, sessions)) {
    if (byId.has(peerId)) continue;
    if (isGuestId(peerId)) continue;
    byId.set(peerId, {
      userId: peerId,
      displayName: peerId
    });
  }

  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) => {
        return (await conn.query(
          `SELECT clerk_user_id, role FROM users WHERE clerk_user_id != ? AND is_banned = 0`,
          [forUserId]
        )) as Array<Record<string, unknown>>;
      });
      for (const row of rows) {
        const uid = String(row.clerk_user_id ?? "");
        if (!uid || byId.has(uid) || isGuestId(uid)) continue;
        const rr = row.role;
        const peerRole: Role | undefined =
          rr === "guest" || rr === "pilot" || rr === "controller" || rr === "mod" || rr === "supermod" || rr === "owner"
            ? rr
            : undefined;
        byId.set(uid, {
          userId: uid,
          displayName: deriveDisplayName(undefined, uid),
          role: peerRole
        });
      }
    } catch (err) {
      logger.warn({ err }, "listDirectMessagePeers: users table lookup failed");
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
  );
}

/**
 * One-shot resolver of every principal the admin Users panel might encounter:
 * configured web users, the KSP voice bridge identities, and known guests.
 * The frontend uses this to (a) render real display names in place of opaque
 * userIds in the Users / Logs / Rooms tables, and (b) hide bridge identities
 * from the derived-users list so the panel stops showing the bridge as a
 * "player".
 */
export interface AdminPrincipal {
  userId: string;
  /** Human-friendly label: email local-part, guest handle, or bridge name. Falls back to `userId`. */
  displayName: string;
  /** True iff this principal is one of the LIVEKIT_BRIDGE_IDENTITIES. */
  isBridge: boolean;
  /** Optional. Set for configured web users; absent for guests / runtime-only ids. */
  role?: Role;
  /** Optional. Set for configured web users only; useful for admin tooltips. */
  email?: string;
}

export async function listAdminPrincipals(): Promise<AdminPrincipal[]> {
  const out = new Map<string, AdminPrincipal>();

  for (const id of listBridgeIdentities()) {
    out.set(id, {
      userId: id,
      displayName: bridgeDisplayName(),
      isBridge: true
    });
  }

  for (const u of listConfiguredWebUsers()) {
    out.set(u.userId, {
      userId: u.userId,
      displayName: deriveDisplayName(u.email, u.userId),
      isBridge: false,
      role: u.role as Role,
      email: u.email
    });
  }

  for (const guest of localGuests.values()) {
    if (out.has(guest.id)) continue;
    out.set(guest.id, {
      userId: guest.id,
      displayName: guest.displayName || guest.id,
      isBridge: false,
      role: "guest"
    });
  }

  return Array.from(out.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
  );
}

/** Best-effort displayName for a DM peer. Mirrors resolveWebSessionDisplayName but local. */
function deriveDisplayName(email: string | undefined, fallbackUserId: string): string {
  if (email && email.length > 0) {
    const at = email.indexOf("@");
    const local = at > 0 ? email.slice(0, at) : email;
    const trimmed = local.trim();
    if (trimmed.length > 0) {
      return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
    }
  }
  return fallbackUserId;
}

export interface ChatRoomSummary {
  sessionId: string;
  messageCount: number;
  lastMessageAt?: string;
}

/** All known sessions (memory + DB), newest first. For admin dashboards. */
export async function listSessionsMerged(): Promise<SessionRecord[]> {
  await ensureServerRadioSessions();
  const byId = new Map<string, SessionRecord>();
  for (const s of localSessions.values()) {
    byId.set(s.id, s);
  }

  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) => {
        return (await conn.query(
          `
          SELECT id, pilot_user_id, assigned_tower_user_id, status, telemetry_json, blocked_users_json,
                 spectator_user_ids_json,
                 squawk, callsign, name, frequency_mhz, checklist_state, checklist_phases,
                 countdown_starts_at, countdown_length_sec,
                 clearances_json, expected_landing_runway,
                 created_at, updated_at
          FROM sessions
          ORDER BY updated_at DESC
          LIMIT 500
          `
        )) as Array<Record<string, unknown>>;
      });
      for (const row of rows) {
        const s = mapSessionRow(row);
        const prev = byId.get(s.id);
        if (!prev || String(prev.updatedAt) < String(s.updatedAt)) {
          byId.set(s.id, s);
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "listSessionsMerged DB failed");
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Distinct session ids that have chat traffic + counts (admin “chat rooms”). */
export async function listChatRoomSummariesAdmin(): Promise<ChatRoomSummary[]> {
  const agg = new Map<string, { messageCount: number; lastMessageAt: string }>();

  for (const [sessionId, msgs] of localSessionMessages.entries()) {
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    agg.set(sessionId, { messageCount: msgs.length, lastMessageAt: last.createdAt });
  }

  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) => {
        return (await conn.query(
          `
          SELECT session_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
          FROM session_messages
          GROUP BY session_id
          ORDER BY last_at DESC
          LIMIT 500
          `
        )) as Array<Record<string, unknown>>;
      });
      for (const row of rows) {
        const sessionId = String(row.session_id);
        const messageCount = Number(row.cnt);
        const lastMessageAt = new Date(String(row.last_at)).toISOString();
        const prev = agg.get(sessionId);
        if (!prev || messageCount >= prev.messageCount) {
          agg.set(sessionId, { messageCount, lastMessageAt });
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "listChatRoomSummariesAdmin DB failed");
    }
  }

  return Array.from(agg.entries())
    .map(([sessionId, v]) => ({
      sessionId,
      messageCount: v.messageCount,
      lastMessageAt: v.lastMessageAt
    }))
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

// ---------------------------------------------------------------------------
// ATC roleplay: scoring, checklists, countdown.
// ---------------------------------------------------------------------------

export interface SessionEventRecord {
  id: string;
  sessionId: string;
  targetUserId: string;
  actorUserId?: string;
  kind: string;
  points: number;
  label: string;
  source: "auto" | "controller" | "client_preview";
  dedupeBucket?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AwardEventInput {
  sessionId: string;
  targetUserId: string;
  actorUserId?: string;
  kind: string;
  points: number;
  label: string;
  source: "auto" | "controller" | "client_preview";
  dedupeBucket?: string;
  metadata?: Record<string, unknown>;
}

interface UserStatsCache {
  rep: number;
  achievements: number;
  penalties: number;
}

const localSessionEvents = new Map<string, SessionEventRecord[]>();
const localUserStats = new Map<string, UserStatsCache>();

function statsDeltaFor(prevPoints: number, nextPoints: number): UserStatsCache {
  const delta: UserStatsCache = { rep: nextPoints - prevPoints, achievements: 0, penalties: 0 };
  if (prevPoints > 0) delta.achievements -= 1;
  if (prevPoints < 0) delta.penalties -= 1;
  if (nextPoints > 0) delta.achievements += 1;
  if (nextPoints < 0) delta.penalties += 1;
  return delta;
}

function applyLocalStats(userId: string, delta: UserStatsCache): void {
  const cur = localUserStats.get(userId) ?? { rep: 0, achievements: 0, penalties: 0 };
  cur.rep += delta.rep;
  cur.achievements += delta.achievements;
  cur.penalties += delta.penalties;
  localUserStats.set(userId, cur);
}

/**
 * Award (or upsert) a scoring event. Three sources collide on `(session, target, kind, dedupeBucket)`:
 *
 * - `client_preview` writes first (instant UI flash on the pilot's machine)
 * - `auto` overwrites it with the canonical row
 * - `controller` rows always have NULL `dedupeBucket`, so they never collide
 *
 * The `users.rep/achievements/penalties` cache is adjusted by the *delta* between the previous
 * row's points (if any) and the new row's points so re-runs never double-count.
 */
export async function awardEvent(input: AwardEventInput): Promise<SessionEventRecord> {
  const id = randomUUID();
  const createdAt = nowIso();
  const dedupeBucket = input.dedupeBucket ?? null;

  // Local path: maintain dedupe across (target, kind, dedupeBucket).
  const list = localSessionEvents.get(input.sessionId) ?? [];
  const existingIdx = dedupeBucket
    ? list.findIndex(
        (e) =>
          e.targetUserId === input.targetUserId &&
          e.kind === input.kind &&
          e.dedupeBucket === dedupeBucket
      )
    : -1;
  const prevPoints = existingIdx >= 0 ? (list[existingIdx]?.points ?? 0) : 0;

  // `auto` always wins over `client_preview` on the same bucket. Reverse direction is a no-op:
  // a late client preview after an auto row should not roll back the actor/source.
  if (existingIdx >= 0) {
    const prev = list[existingIdx]!;
    if (prev.source === "auto" && input.source === "client_preview") {
      return prev;
    }
  }

  const record: SessionEventRecord = {
    id: existingIdx >= 0 ? list[existingIdx]!.id : id,
    sessionId: input.sessionId,
    targetUserId: input.targetUserId,
    actorUserId: input.actorUserId,
    kind: input.kind,
    points: input.points,
    label: input.label,
    source: input.source,
    dedupeBucket: dedupeBucket ?? undefined,
    metadata: input.metadata,
    createdAt: existingIdx >= 0 ? list[existingIdx]!.createdAt : createdAt
  };

  if (existingIdx >= 0) {
    list[existingIdx] = record;
  } else {
    list.push(record);
  }
  localSessionEvents.set(input.sessionId, list);
  applyLocalStats(input.targetUserId, statsDeltaFor(prevPoints, input.points));

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.beginTransaction();
        try {
          // Look up the existing row (if any) so we can compute the delta accurately even when
          // another worker raced us. The UNIQUE key gives us a single-row lookup.
          const prior = dedupeBucket
            ? ((await conn.query(
                `
                SELECT id, points, source FROM session_events
                WHERE session_id = ? AND target_user_id = ? AND kind = ? AND dedupe_bucket = ?
                LIMIT 1
                `,
                [input.sessionId, input.targetUserId, input.kind, dedupeBucket]
              )) as Array<Record<string, unknown>>)
            : [];
          const dbPrev = prior[0];
          if (dbPrev && dbPrev.source === "auto" && input.source === "client_preview") {
            await conn.commit();
            return;
          }
          const dbPrevPoints = dbPrev ? Number(dbPrev.points ?? 0) : 0;

          await conn.query(
            `
            INSERT INTO session_events
              (id, session_id, target_user_id, actor_user_id, kind, points, label, source, dedupe_bucket, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              actor_user_id = VALUES(actor_user_id),
              points = VALUES(points),
              label = VALUES(label),
              source = VALUES(source),
              metadata_json = VALUES(metadata_json)
            `,
            [
              dbPrev ? String(dbPrev.id) : record.id,
              input.sessionId,
              input.targetUserId,
              input.actorUserId ?? null,
              input.kind,
              input.points,
              input.label.slice(0, 160),
              input.source,
              dedupeBucket,
              input.metadata ? JSON.stringify(input.metadata) : null
            ]
          );

          const delta = statsDeltaFor(dbPrevPoints, input.points);
          if (delta.rep !== 0 || delta.achievements !== 0 || delta.penalties !== 0) {
            // Guests don't have a users row; skip the counter update silently for them.
            if (!isGuestId(input.targetUserId)) {
              await conn.query(
                `
                UPDATE users
                SET rep = rep + ?, achievements = achievements + ?, penalties = penalties + ?, updated_at = CURRENT_TIMESTAMP
                WHERE clerk_user_id = ?
                `,
                [delta.rep, delta.achievements, delta.penalties, input.targetUserId]
              );
            }
          }

          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        }
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist scoring event");
    }
  }

  return record;
}

export interface ScorecardEntry {
  userId: string;
  rep: number;
  achievements: number;
  penalties: number;
}

export interface SessionScorecard {
  sessionId: string;
  events: SessionEventRecord[];
  totals: ScorecardEntry[];
}

export async function getSessionScorecard(sessionId: string): Promise<SessionScorecard> {
  let events: SessionEventRecord[] = [];
  if (useDbPersistence()) {
    try {
      events = await withConn(async (conn) => {
        const rows = (await conn.query(
          `
          SELECT id, session_id, target_user_id, actor_user_id, kind, points, label, source, dedupe_bucket, metadata_json, created_at
          FROM session_events
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT 500
          `,
          [sessionId]
        )) as Array<Record<string, unknown>>;
        return rows.map(mapEventRow);
      });
    } catch {
      events = [...(localSessionEvents.get(sessionId) ?? [])].reverse();
    }
  } else {
    events = [...(localSessionEvents.get(sessionId) ?? [])].reverse();
  }

  const totals = new Map<string, ScorecardEntry>();
  for (const ev of events) {
    const cur = totals.get(ev.targetUserId) ?? {
      userId: ev.targetUserId,
      rep: 0,
      achievements: 0,
      penalties: 0
    };
    cur.rep += ev.points;
    if (ev.points > 0) cur.achievements += 1;
    if (ev.points < 0) cur.penalties += 1;
    totals.set(ev.targetUserId, cur);
  }

  return {
    sessionId,
    events,
    totals: Array.from(totals.values()).sort((a, b) => b.rep - a.rep)
  };
}

function mapEventRow(row: Record<string, unknown>): SessionEventRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    targetUserId: String(row.target_user_id),
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : undefined,
    kind: String(row.kind),
    points: Number(row.points ?? 0),
    label: String(row.label),
    source: String(row.source ?? "auto") as SessionEventRecord["source"],
    dedupeBucket: row.dedupe_bucket ? String(row.dedupe_bucket) : undefined,
    metadata: safeJsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export interface UserProfile {
  userId: string;
  rep: number;
  achievements: number;
  penalties: number;
  recent: SessionEventRecord[];
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  let totals: UserStatsCache = localUserStats.get(userId) ?? { rep: 0, achievements: 0, penalties: 0 };
  let recent: SessionEventRecord[] = [];

  if (useDbPersistence()) {
    try {
      const result = await withConn(async (conn) => {
        const userRows = isGuestId(userId)
          ? []
          : ((await conn.query(
              `SELECT rep, achievements, penalties FROM users WHERE clerk_user_id = ? LIMIT 1`,
              [userId]
            )) as Array<Record<string, unknown>>);
        const evRows = (await conn.query(
          `
          SELECT id, session_id, target_user_id, actor_user_id, kind, points, label, source, dedupe_bucket, metadata_json, created_at
          FROM session_events
          WHERE target_user_id = ?
          ORDER BY created_at DESC
          LIMIT 20
          `,
          [userId]
        )) as Array<Record<string, unknown>>;
        return { user: userRows[0], events: evRows };
      });
      if (result.user) {
        totals = {
          rep: Number(result.user.rep ?? 0),
          achievements: Number(result.user.achievements ?? 0),
          penalties: Number(result.user.penalties ?? 0)
        };
      }
      recent = result.events.map(mapEventRow);
    } catch {
      // fall through to local
    }
  }

  if (recent.length === 0) {
    const all: SessionEventRecord[] = [];
    for (const list of localSessionEvents.values()) {
      for (const ev of list) {
        if (ev.targetUserId === userId) all.push(ev);
      }
    }
    recent = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  }

  return { userId, rep: totals.rep, achievements: totals.achievements, penalties: totals.penalties, recent };
}

// ---------------------------------------------------------------------------
// Checklist templates + per-session checklist phase overrides.
// ---------------------------------------------------------------------------

const localChecklistTemplates = new Map<string, ChecklistTemplateRecord>();

const SLUG_RE = /[^a-z0-9]+/g;
function slugify(input: string, fallback: string): string {
  const s = input.toLowerCase().replace(SLUG_RE, "_").replace(/^_+|_+$/g, "");
  return s || fallback;
}

/**
 * Validate a phases payload coming from the wire (template body, session phases PUT).
 * Returns a sanitized copy with predictable shapes; throws on a structural mismatch so
 * the route handler can return 400. This is deliberately stricter than `safeJsonParse`:
 * we never want a half-shaped phase array to land in the DB and break later renders.
 */
export function sanitizeChecklistPhases(input: unknown): ChecklistPhaseDef[] {
  if (!Array.isArray(input)) {
    throw new Error("phases must be an array");
  }
  const out: ChecklistPhaseDef[] = [];
  const seenPhaseIds = new Set<string>();
  for (let pi = 0; pi < input.length; pi++) {
    const raw = input[pi] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      throw new Error(`phase[${pi}] must be an object`);
    }
    const id = String(raw.id ?? "").trim() || `phase_${pi + 1}`;
    if (seenPhaseIds.has(id)) {
      throw new Error(`duplicate phase id '${id}'`);
    }
    seenPhaseIds.add(id);
    const title = String(raw.title ?? "").trim() || "Untitled phase";
    const sides: Array<ChecklistSide> = ["pilot", "controller"];
    const sideArrays: Record<ChecklistSide, ChecklistItemDef[]> = { pilot: [], controller: [] };
    for (const side of sides) {
      const list = raw[side];
      if (list != null && !Array.isArray(list)) {
        throw new Error(`phase[${pi}].${side} must be an array`);
      }
      const arr = Array.isArray(list) ? list : [];
      const seen = new Set<string>();
      for (let ii = 0; ii < arr.length; ii++) {
        const r = arr[ii] as Record<string, unknown> | null;
        if (!r || typeof r !== "object") {
          throw new Error(`phase[${pi}].${side}[${ii}] must be an object`);
        }
        const itemLabel = String(r.label ?? "").trim();
        if (!itemLabel) {
          throw new Error(`phase[${pi}].${side}[${ii}] missing label`);
        }
        const itemId = (String(r.id ?? "").trim() || `${side[0]}_${id}_${ii + 1}`).slice(0, 64);
        const autoRule = sanitizeAutoRule(r.autoRule);
        if (seen.has(itemId)) {
          // Suffix to keep the rest of the import going rather than rejecting the whole template.
          let bump = 2;
          while (seen.has(`${itemId}_${bump}`)) bump++;
          sideArrays[side].push({ id: `${itemId}_${bump}`, label: itemLabel.slice(0, 200), autoRule });
          seen.add(`${itemId}_${bump}`);
          continue;
        }
        seen.add(itemId);
        sideArrays[side].push({ id: itemId, label: itemLabel.slice(0, 200), autoRule });
      }
    }
    out.push({ id, title: title.slice(0, 80), pilot: sideArrays.pilot, controller: sideArrays.controller });
  }
  return out;
}

/**
 * Strip and validate an `autoRule` candidate. Unknown shapes / kinds become `undefined`
 * (silently dropped) instead of throwing, so a future rule kind from a newer client
 * doesn't break older session reads.
 */
function sanitizeAutoRule(input: unknown): ChecklistAutoRule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  if (r.kind !== "telemetry") return undefined;
  const expr = typeof r.expr === "string" ? r.expr.trim() : "";
  if (!expr || expr.length > 200) return undefined;
  return { kind: "telemetry", expr };
}

const AUTO_RULE_RE =
  /^([a-zA-Z_][a-zA-Z0-9_]{0,31})\s*(==|!=|>=|<=|>|<)\s*(true|false|-?\d+(?:\.\d+)?)$/;

/**
 * Tiny safe DSL for `autoRule.expr`. Supports a single comparison of a telemetry field
 * (whitelisted by the regex) against a literal boolean or number. Returning `undefined`
 * means the rule is unparseable; returning `false` means it parsed but the condition
 * isn't met by this telemetry sample.
 */
export function evaluateAutoRule(
  rule: ChecklistAutoRule | undefined,
  telemetry: TelemetrySample | undefined
): boolean {
  if (!rule || rule.kind !== "telemetry" || !telemetry) return false;
  const m = AUTO_RULE_RE.exec(rule.expr);
  if (!m) return false;
  const field = m[1] ?? "";
  const op = m[2] ?? "";
  const rhs = m[3] ?? "";
  const lhs = (telemetry as Record<string, unknown>)[field];
  let want: boolean | number;
  if (rhs === "true") want = true;
  else if (rhs === "false") want = false;
  else want = Number(rhs);
  if (typeof want === "boolean") {
    if (typeof lhs !== "boolean") return false;
    return op === "==" ? lhs === want : op === "!=" ? lhs !== want : false;
  }
  if (typeof lhs !== "number" || Number.isNaN(lhs)) return false;
  switch (op) {
    case "==": return lhs === want;
    case "!=": return lhs !== want;
    case ">":  return lhs > want;
    case ">=": return lhs >= want;
    case "<":  return lhs < want;
    case "<=": return lhs <= want;
    default:   return false;
  }
}

/** Returns true iff every item on `side` across all phases has a tick in `state`. */
export function checklistSideComplete(
  phases: ChecklistPhaseDef[],
  state: ChecklistState | undefined,
  side: ChecklistSide
): boolean {
  const sideState = state?.[side] ?? {};
  for (const p of phases) {
    for (const it of p[side]) {
      if (!sideState[it.id]) return false;
    }
  }
  // Empty side counts as complete only if there are *some* items defined; otherwise we
  // never want a "pilot complete" announce on a checklist with zero pilot items.
  let total = 0;
  for (const p of phases) total += p[side].length;
  return total > 0;
}

/**
 * Run every `autoRule` on the pilot side against the current telemetry, ticking matched
 * items that aren't already done. Returns the list of itemIds that flipped this pass so
 * the route can announce them. Controller-side autoRules are intentionally not honored
 * — controller ticks are a roleplay action, not a measurement.
 */
export async function evaluateAndApplyAutoRules(
  sessionId: string,
  phases: ChecklistPhaseDef[],
  telemetry: TelemetrySample | undefined
): Promise<string[]> {
  if (!telemetry) return [];
  const session = await getSession(sessionId);
  if (!session) return [];
  const state: ChecklistState = session.checklistState ?? { pilot: {}, controller: {} };
  const sideMap = state.pilot ?? {};
  const flipped: string[] = [];
  for (const p of phases) {
    for (const it of p.pilot) {
      if (!it.autoRule) continue;
      if (sideMap[it.id]) continue;
      if (evaluateAutoRule(it.autoRule, telemetry)) {
        sideMap[it.id] = { doneAt: nowIso(), byUserId: "system:autoRule" };
        flipped.push(it.id);
      }
    }
  }
  if (flipped.length === 0) return [];
  state.pilot = sideMap;
  session.checklistState = state;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `UPDATE sessions SET checklist_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [JSON.stringify(state), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist autoRule ticks");
    }
  }
  return flipped;
}

function mapChecklistTemplateRow(row: Record<string, unknown>): ChecklistTemplateRecord {
  const rawScope = String(row.scope ?? "user");
  const scope: ChecklistTemplateScope =
    rawScope === "craft" ? "craft" : rawScope === "global" ? "global" : "user";
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    scope,
    craftName: row.craft_name ? String(row.craft_name) : undefined,
    name: String(row.name ?? "Untitled"),
    isDefault: Number(row.is_default ?? 0) === 1,
    phases: safeJsonParse<ChecklistPhaseDef[]>(row.phases_json, []),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

/**
 * List checklist templates visible to a user. Returns:
 *   - all `scope='user'` templates owned by `ownerUserId`,
 *   - `scope='craft'` templates owned by them whose craft matches `craftName` (when given),
 *   - all `scope='global'` templates (regardless of owner) — these are mod-curated and
 *     visible to everyone with `chat:session`.
 */
export async function listChecklistTemplates(
  ownerUserId: string,
  craftName?: string
): Promise<ChecklistTemplateRecord[]> {
  const norm = craftName ? craftName.trim() : "";
  const result: ChecklistTemplateRecord[] = [];
  for (const tpl of localChecklistTemplates.values()) {
    if (tpl.scope === "global") {
      result.push(tpl);
      continue;
    }
    if (tpl.ownerUserId !== ownerUserId) continue;
    if (tpl.scope === "craft" && norm && tpl.craftName?.toLowerCase() !== norm.toLowerCase()) continue;
    result.push(tpl);
  }

  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) => {
        if (norm) {
          return (await conn.query(
            `
            SELECT id, owner_user_id, scope, craft_name, name, is_default, phases_json,
                   created_at, updated_at
            FROM checklist_templates
            WHERE scope = 'global'
               OR (owner_user_id = ? AND (scope = 'user'
                   OR (scope = 'craft' AND LOWER(craft_name) = LOWER(?))))
            ORDER BY scope DESC, is_default DESC, updated_at DESC
            LIMIT 200
            `,
            [ownerUserId, norm]
          )) as Array<Record<string, unknown>>;
        }
        return (await conn.query(
          `
          SELECT id, owner_user_id, scope, craft_name, name, is_default, phases_json,
                 created_at, updated_at
          FROM checklist_templates
          WHERE scope = 'global' OR owner_user_id = ?
          ORDER BY scope DESC, is_default DESC, updated_at DESC
          LIMIT 200
          `,
          [ownerUserId]
        )) as Array<Record<string, unknown>>;
      });
      const seen = new Set(result.map((r) => r.id));
      for (const row of rows) {
        const t = mapChecklistTemplateRow(row);
        if (!seen.has(t.id)) result.push(t);
      }
    } catch (error) {
      logger.warn({ err: error }, "listChecklistTemplates DB failed; returning local only");
    }
  }
  return result;
}

export async function getChecklistTemplate(
  templateId: string
): Promise<ChecklistTemplateRecord | undefined> {
  const local = localChecklistTemplates.get(templateId);
  if (local) return local;
  if (!useDbPersistence()) return undefined;
  try {
    return await withConn(async (conn) => {
      const rows = (await conn.query(
        `
        SELECT id, owner_user_id, scope, craft_name, name, is_default, phases_json,
               created_at, updated_at
        FROM checklist_templates
        WHERE id = ?
        `,
        [templateId]
      )) as Array<Record<string, unknown>>;
      const r = rows[0];
      return r ? mapChecklistTemplateRow(r) : undefined;
    });
  } catch {
    return undefined;
  }
}

export interface ChecklistTemplateInput {
  scope: ChecklistTemplateScope;
  craftName?: string;
  name: string;
  isDefault?: boolean;
  phases: ChecklistPhaseDef[];
}

export async function createChecklistTemplate(
  ownerUserId: string,
  input: ChecklistTemplateInput
): Promise<ChecklistTemplateRecord> {
  const id = randomUUID();
  const createdAt = nowIso();
  const phases = sanitizeChecklistPhases(input.phases);
  const craftName = input.scope === "craft" ? (input.craftName ?? "").trim() || undefined : undefined;
  if (input.scope === "craft" && !craftName) {
    throw new Error("craftName is required for scope='craft'");
  }
  if (input.scope === "global" && input.craftName) {
    // Global templates intentionally don't carry a craft binding; a curator wanting
    // craft-specific defaults can publish multiple global templates.
    throw new Error("scope='global' templates cannot have a craftName");
  }
  const rec: ChecklistTemplateRecord = {
    id,
    ownerUserId,
    scope: input.scope,
    craftName,
    name: input.name.trim().slice(0, 120) || "Untitled checklist",
    isDefault: !!input.isDefault,
    phases,
    createdAt,
    updatedAt: createdAt
  };
  localChecklistTemplates.set(id, rec);

  // is_default is a single-default-per-(owner, scope, craft) flag. Clear the previous default
  // before writing this row so the UI can rely on "at most one default per scope".
  if (rec.isDefault) {
    for (const t of localChecklistTemplates.values()) {
      if (t.id === id) continue;
      if (t.ownerUserId !== ownerUserId) continue;
      if (t.scope !== rec.scope) continue;
      if (t.scope === "craft" && t.craftName?.toLowerCase() !== rec.craftName?.toLowerCase()) continue;
      if (t.isDefault) {
        t.isDefault = false;
        localChecklistTemplates.set(t.id, t);
      }
    }
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        if (rec.isDefault) {
          await conn.query(
            `UPDATE checklist_templates
             SET is_default = 0, updated_at = CURRENT_TIMESTAMP
             WHERE owner_user_id = ? AND scope = ?
               AND (? IS NULL OR LOWER(IFNULL(craft_name, '')) = LOWER(?))
               AND is_default = 1`,
            [ownerUserId, rec.scope, rec.craftName ?? null, rec.craftName ?? ""]
          );
        }
        await conn.query(
          `INSERT INTO checklist_templates
             (id, owner_user_id, scope, craft_name, name, is_default, phases_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            rec.id,
            rec.ownerUserId,
            rec.scope,
            rec.craftName ?? null,
            rec.name,
            rec.isDefault ? 1 : 0,
            JSON.stringify(rec.phases)
          ]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist checklist template");
    }
  }
  return rec;
}

export async function updateChecklistTemplate(
  templateId: string,
  ownerUserId: string,
  patch: Partial<ChecklistTemplateInput>
): Promise<ChecklistTemplateRecord | undefined> {
  const existing = await getChecklistTemplate(templateId);
  if (!existing || existing.ownerUserId !== ownerUserId) return undefined;
  const next: ChecklistTemplateRecord = { ...existing, updatedAt: nowIso() };
  if (patch.name != null) next.name = patch.name.trim().slice(0, 120) || existing.name;
  if (patch.scope != null) next.scope = patch.scope;
  if (patch.craftName !== undefined) {
    next.craftName = patch.craftName ? patch.craftName.trim() || undefined : undefined;
  }
  if (patch.isDefault != null) next.isDefault = !!patch.isDefault;
  if (patch.phases != null) next.phases = sanitizeChecklistPhases(patch.phases);
  if (next.scope === "craft" && !next.craftName) {
    throw new Error("craftName is required for scope='craft'");
  }
  localChecklistTemplates.set(next.id, next);

  if (next.isDefault) {
    for (const t of localChecklistTemplates.values()) {
      if (t.id === next.id) continue;
      if (t.ownerUserId !== ownerUserId) continue;
      if (t.scope !== next.scope) continue;
      if (t.scope === "craft" && t.craftName?.toLowerCase() !== next.craftName?.toLowerCase()) continue;
      if (t.isDefault) {
        t.isDefault = false;
        localChecklistTemplates.set(t.id, t);
      }
    }
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        if (next.isDefault) {
          await conn.query(
            `UPDATE checklist_templates
             SET is_default = 0, updated_at = CURRENT_TIMESTAMP
             WHERE owner_user_id = ? AND scope = ?
               AND id <> ?
               AND (? IS NULL OR LOWER(IFNULL(craft_name, '')) = LOWER(?))
               AND is_default = 1`,
            [ownerUserId, next.scope, next.id, next.craftName ?? null, next.craftName ?? ""]
          );
        }
        await conn.query(
          `UPDATE checklist_templates
           SET scope = ?, craft_name = ?, name = ?, is_default = ?, phases_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND owner_user_id = ?`,
          [
            next.scope,
            next.craftName ?? null,
            next.name,
            next.isDefault ? 1 : 0,
            JSON.stringify(next.phases),
            next.id,
            ownerUserId
          ]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to update checklist template");
    }
  }
  return next;
}

export async function deleteChecklistTemplate(
  templateId: string,
  ownerUserId: string
): Promise<boolean> {
  const existing = await getChecklistTemplate(templateId);
  if (!existing || existing.ownerUserId !== ownerUserId) return false;
  localChecklistTemplates.delete(templateId);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `DELETE FROM checklist_templates WHERE id = ? AND owner_user_id = ?`,
          [templateId, ownerUserId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to delete checklist template");
    }
  }
  return true;
}

/**
 * Replace (or clear) the per-session checklist phase override. Pass `null` to fall back
 * to the hardcoded template. Caller is responsible for permission checks; this just persists.
 */
export async function setSessionChecklistPhases(
  sessionId: string,
  phases: ChecklistPhaseDef[] | null
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.checklistPhases = phases ?? undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `UPDATE sessions
           SET checklist_phases = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [phases ? JSON.stringify(phases) : null, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist session checklist phases");
    }
  }
  return session;
}

/**
 * Add a single checklist item to the session's effective phases. If the session has no
 * `checklistPhases` override yet, callers should pass the resolved default (hardcoded
 * template) as `basePhases` so we materialize the override before mutating.
 *
 * Returns the new item id and the updated session (with `checklistPhases` populated).
 */
export async function addSessionChecklistItem(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  phaseId: string;
  side: ChecklistSide;
  label: string;
}): Promise<{ session: SessionRecord; itemId: string } | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: [...p.pilot],
    controller: [...p.controller]
  }));
  const phase = phases.find((p) => p.id === args.phaseId);
  if (!phase) {
    throw new Error(`Unknown phase id '${args.phaseId}'`);
  }
  const cleaned = args.label.trim().slice(0, 200);
  if (!cleaned) {
    throw new Error("Item label is required");
  }
  const baseId = `${args.side[0]}_${slugify(cleaned, args.phaseId)}`.slice(0, 56);
  const taken = new Set<string>();
  for (const p of phases) for (const it of p[args.side]) taken.add(it.id);
  let itemId = baseId;
  let bump = 2;
  while (taken.has(itemId)) {
    itemId = `${baseId}_${bump++}`.slice(0, 64);
  }
  phase[args.side].push({ id: itemId, label: cleaned });
  const updated = await setSessionChecklistPhases(args.sessionId, phases);
  if (!updated) return undefined;
  return { session: updated, itemId };
}

export async function renameSessionChecklistItem(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  itemId: string;
  label: string;
  /**
   * Optional auto-tick rule:
   *   - `undefined` leaves the existing rule untouched (rename only)
   *   - `null` clears any existing rule
   *   - an object replaces / sets the rule
   */
  autoRule?: ChecklistAutoRule | null;
}): Promise<SessionRecord | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: p.pilot.map((it) => ({ ...it })),
    controller: p.controller.map((it) => ({ ...it }))
  }));
  const cleaned = args.label.trim().slice(0, 200);
  if (!cleaned) {
    throw new Error("Item label is required");
  }
  let found = false;
  for (const p of phases) {
    for (const side of ["pilot", "controller"] as const) {
      const it = p[side].find((x) => x.id === args.itemId);
      if (it) {
        it.label = cleaned;
        if (args.autoRule === null) {
          delete it.autoRule;
        } else if (args.autoRule !== undefined) {
          const sanitized = sanitizeAutoRule(args.autoRule);
          if (sanitized) it.autoRule = sanitized;
          else delete it.autoRule;
        }
        found = true;
      }
    }
  }
  if (!found) {
    throw new Error(`Unknown item id '${args.itemId}'`);
  }
  return await setSessionChecklistPhases(args.sessionId, phases);
}

export async function removeSessionChecklistItem(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  itemId: string;
}): Promise<SessionRecord | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: p.pilot.filter((it) => it.id !== args.itemId),
    controller: p.controller.filter((it) => it.id !== args.itemId)
  }));
  // Also drop the tick state for the removed id so a future re-add of the same id starts unchecked.
  if (session.checklistState) {
    delete session.checklistState.pilot[args.itemId];
    delete session.checklistState.controller[args.itemId];
    if (useDbPersistence()) {
      try {
        await withConn(async (conn) => {
          await conn.query(
            `UPDATE sessions SET checklist_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(session.checklistState), args.sessionId]
          );
        });
      } catch (error) {
        logger.warn({ err: error }, "Failed to prune checklist_state on item remove");
      }
    }
  }
  return await setSessionChecklistPhases(args.sessionId, phases);
}

// ---------------------------------------------------------------------------
// Phase-level CRUD on the per-session checklist override.
// ---------------------------------------------------------------------------

export async function addSessionChecklistPhase(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  title: string;
  /** Insert at this index. Default = end of list. */
  index?: number;
}): Promise<{ session: SessionRecord; phaseId: string } | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const cleaned = args.title.trim().slice(0, 80);
  if (!cleaned) throw new Error("Phase title is required");
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: [...p.pilot],
    controller: [...p.controller]
  }));
  const taken = new Set(phases.map((p) => p.id));
  const baseId = slugify(cleaned, "phase");
  let phaseId = baseId;
  let bump = 2;
  while (taken.has(phaseId)) phaseId = `${baseId}_${bump++}`.slice(0, 64);
  const newPhase: ChecklistPhaseDef = { id: phaseId, title: cleaned, pilot: [], controller: [] };
  const at = typeof args.index === "number" ? Math.max(0, Math.min(phases.length, args.index)) : phases.length;
  phases.splice(at, 0, newPhase);
  const updated = await setSessionChecklistPhases(args.sessionId, phases);
  if (!updated) return undefined;
  return { session: updated, phaseId };
}

export async function renameSessionChecklistPhase(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  phaseId: string;
  title: string;
}): Promise<SessionRecord | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const cleaned = args.title.trim().slice(0, 80);
  if (!cleaned) throw new Error("Phase title is required");
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: [...p.pilot],
    controller: [...p.controller]
  }));
  const phase = phases.find((p) => p.id === args.phaseId);
  if (!phase) throw new Error(`Unknown phase id '${args.phaseId}'`);
  phase.title = cleaned;
  return await setSessionChecklistPhases(args.sessionId, phases);
}

export async function removeSessionChecklistPhase(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  phaseId: string;
}): Promise<SessionRecord | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const before = session.checklistPhases ?? args.basePhases;
  const removed = before.find((p) => p.id === args.phaseId);
  if (!removed) throw new Error(`Unknown phase id '${args.phaseId}'`);
  const phases = before.filter((p) => p.id !== args.phaseId).map((p) => ({
    ...p,
    pilot: [...p.pilot],
    controller: [...p.controller]
  }));
  // Drop any tick state for items inside the removed phase.
  if (session.checklistState) {
    for (const it of removed.pilot) delete session.checklistState.pilot[it.id];
    for (const it of removed.controller) delete session.checklistState.controller[it.id];
    if (useDbPersistence()) {
      try {
        await withConn(async (conn) => {
          await conn.query(
            `UPDATE sessions SET checklist_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(session.checklistState), args.sessionId]
          );
        });
      } catch (error) {
        logger.warn({ err: error }, "Failed to prune checklist_state on phase remove");
      }
    }
  }
  return await setSessionChecklistPhases(args.sessionId, phases);
}

/**
 * Reorder phases by id. Any phaseId not present in the session's current phases is ignored;
 * any current phase missing from `order` is appended in its existing relative position.
 */
export async function reorderSessionChecklistPhases(args: {
  sessionId: string;
  basePhases: ChecklistPhaseDef[];
  order: string[];
}): Promise<SessionRecord | undefined> {
  const session = await getSession(args.sessionId);
  if (!session) return undefined;
  const phases = (session.checklistPhases ?? args.basePhases).map((p) => ({
    ...p,
    pilot: [...p.pilot],
    controller: [...p.controller]
  }));
  const byId = new Map(phases.map((p) => [p.id, p] as const));
  const wantedSeen = new Set<string>();
  const next: ChecklistPhaseDef[] = [];
  for (const id of args.order) {
    const phase = byId.get(id);
    if (!phase || wantedSeen.has(id)) continue;
    wantedSeen.add(id);
    next.push(phase);
  }
  for (const p of phases) {
    if (!wantedSeen.has(p.id)) next.push(p);
  }
  return await setSessionChecklistPhases(args.sessionId, next);
}

/**
 * Toggle a single checklist item. The opposite-side toggle is rejected upstream by the
 * route — this function just persists what it's told. Returns both the new state and a
 * flag for whether *this* toggle just turned the side complete (so the route can fire
 * an ACARS announce exactly once per completion).
 */
export async function toggleChecklistItem(
  sessionId: string,
  side: "pilot" | "controller",
  itemId: string,
  byUserId: string,
  basePhases?: ChecklistPhaseDef[]
): Promise<{ state: ChecklistState; sideJustCompleted: boolean }> {
  const session = await getSession(sessionId);
  const current: ChecklistState = session?.checklistState ?? { pilot: {}, controller: {} };
  const phases = session?.checklistPhases ?? basePhases ?? [];
  const wasComplete = checklistSideComplete(phases, current, side);
  const sideMap = current[side] ?? {};
  if (sideMap[itemId]) {
    delete sideMap[itemId];
  } else {
    sideMap[itemId] = { doneAt: nowIso(), byUserId };
  }
  current[side] = sideMap;

  const next: ChecklistState = current;
  if (session) {
    session.checklistState = next;
    session.updatedAt = nowIso();
    localSessions.set(session.id, session);
  }

  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET checklist_state = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [JSON.stringify(next), sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist checklist toggle");
    }
  }

  const isCompleteNow = checklistSideComplete(phases, next, side);
  return { state: next, sideJustCompleted: !wasComplete && isCompleteNow };
}

// ---------------------------------------------------------------------------
// Checklist send-to-tower receipts (`checklist_sends` table).
// ---------------------------------------------------------------------------

export interface ChecklistSendRecord {
  id: string;
  sessionId: string;
  messageId: string;
  templateId?: string;
  templateName: string;
  sentByUserId: string;
  createdAt: string;
  ackUserId?: string;
  ackAt?: string;
}

const localChecklistSends = new Map<string, ChecklistSendRecord>();

export async function recordChecklistSend(args: {
  sessionId: string;
  messageId: string;
  templateId?: string;
  templateName: string;
  sentByUserId: string;
}): Promise<ChecklistSendRecord> {
  const rec: ChecklistSendRecord = {
    id: randomUUID(),
    sessionId: args.sessionId,
    messageId: args.messageId,
    templateId: args.templateId,
    templateName: args.templateName.slice(0, 120),
    sentByUserId: args.sentByUserId,
    createdAt: nowIso()
  };
  localChecklistSends.set(rec.id, rec);
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `INSERT INTO checklist_sends
             (id, session_id, message_id, template_id, template_name, sent_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [rec.id, rec.sessionId, rec.messageId, rec.templateId ?? null, rec.templateName, rec.sentByUserId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist checklist send receipt");
    }
  }
  return rec;
}

function mapChecklistSendRow(row: Record<string, unknown>): ChecklistSendRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    templateId: row.template_id ? String(row.template_id) : undefined,
    templateName: String(row.template_name ?? ""),
    sentByUserId: String(row.sent_by_user_id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ackUserId: row.ack_user_id ? String(row.ack_user_id) : undefined,
    ackAt: row.ack_at ? new Date(String(row.ack_at)).toISOString() : undefined
  };
}

/** Most-recent send for a session, or undefined if none. Used for the GET /checklist payload. */
export async function latestChecklistSend(sessionId: string): Promise<ChecklistSendRecord | undefined> {
  let best: ChecklistSendRecord | undefined;
  for (const r of localChecklistSends.values()) {
    if (r.sessionId !== sessionId) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  if (useDbPersistence()) {
    try {
      const rows = await withConn(async (conn) =>
        (await conn.query(
          `SELECT id, session_id, message_id, template_id, template_name, sent_by_user_id,
                  created_at, ack_user_id, ack_at
             FROM checklist_sends
             WHERE session_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
          [sessionId]
        )) as Array<Record<string, unknown>>
      );
      if (rows[0]) {
        const fromDb = mapChecklistSendRow(rows[0]);
        if (!best || fromDb.createdAt > best.createdAt) best = fromDb;
      }
    } catch (error) {
      logger.warn({ err: error }, "latestChecklistSend DB failed; using local only");
    }
  }
  return best;
}

export async function ackChecklistSend(
  sendId: string,
  ackUserId: string
): Promise<ChecklistSendRecord | undefined> {
  const ackAt = nowIso();
  let rec = localChecklistSends.get(sendId);
  if (rec) {
    rec.ackUserId = ackUserId;
    rec.ackAt = ackAt;
    localChecklistSends.set(rec.id, rec);
  }
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `UPDATE checklist_sends
             SET ack_user_id = ?, ack_at = CURRENT_TIMESTAMP
             WHERE id = ? AND ack_user_id IS NULL`,
          [ackUserId, sendId]
        );
      });
      if (!rec) {
        const rows = (await withConn(async (conn) =>
          (await conn.query(
            `SELECT id, session_id, message_id, template_id, template_name, sent_by_user_id,
                    created_at, ack_user_id, ack_at
               FROM checklist_sends WHERE id = ?`,
            [sendId]
          )) as Array<Record<string, unknown>>
        )) as Array<Record<string, unknown>>;
        if (rows[0]) rec = mapChecklistSendRow(rows[0]);
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist checklist ack");
    }
  }
  return rec;
}

export async function getChecklistSend(sendId: string): Promise<ChecklistSendRecord | undefined> {
  const local = localChecklistSends.get(sendId);
  if (local) return local;
  if (!useDbPersistence()) return undefined;
  try {
    return await withConn(async (conn) => {
      const rows = (await conn.query(
        `SELECT id, session_id, message_id, template_id, template_name, sent_by_user_id,
                created_at, ack_user_id, ack_at
           FROM checklist_sends WHERE id = ?`,
        [sendId]
      )) as Array<Record<string, unknown>>;
      return rows[0] ? mapChecklistSendRow(rows[0]) : undefined;
    });
  } catch {
    return undefined;
  }
}

export async function startCountdown(
  sessionId: string,
  lengthSec: number
): Promise<{ startsAt: string; lengthSec: number }> {
  const startsAt = nowIso();
  const session = await getSession(sessionId);
  if (session) {
    session.countdownStartsAt = startsAt;
    session.countdownLengthSec = lengthSec;
    session.countdownRequest = undefined;
    session.takeoffRequest = undefined;
    session.updatedAt = startsAt;
    localSessions.set(session.id, session);
    publishLiveSnapshotEvent({ topic: "session", sessionId });
  }
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET countdown_starts_at = NOW(), countdown_length_sec = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [lengthSec, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist countdown start");
    }
  }
  return { startsAt, lengthSec };
}

export async function clearCountdown(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (session) {
    session.countdownStartsAt = undefined;
    session.countdownLengthSec = undefined;
    session.countdownRequest = undefined;
    session.updatedAt = nowIso();
    localSessions.set(session.id, session);
    publishLiveSnapshotEvent({ topic: "session", sessionId });
  }
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET countdown_starts_at = NULL, countdown_length_sec = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to clear countdown");
    }
  }
}

export async function setCountdownRequest(
  sessionId: string,
  request: { at: string; byUserId: string; label?: string }
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.countdownRequest = request;
  session.takeoffRequest = undefined;
  session.updatedAt = request.at;
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

/** Takeoff pings age out so tower tiles do not stick forever (no "start" event like countdown). */
const TAKEOFF_REQUEST_TTL_MS = 10 * 60 * 1000;

/** Staging-move hints age out so a forgotten tower click does not stick forever. */
const STAGING_MOVE_REQUEST_TTL_MS = 15 * 60 * 1000;

export function pruneStaleTakeoffRequest(session: SessionRecord): void {
  const r = session.takeoffRequest;
  if (!r?.at) {
    return;
  }
  const t = Date.parse(r.at);
  if (!Number.isFinite(t) || Date.now() - t > TAKEOFF_REQUEST_TTL_MS) {
    session.takeoffRequest = undefined;
    publishLiveSnapshotEvent({ topic: "session", sessionId: session.id });
  }
}

export function pruneStaleStagingMoveRequest(session: SessionRecord): void {
  const r = session.stagingMoveRequest;
  if (!r?.issuedAt) {
    return;
  }
  const t = Date.parse(r.issuedAt);
  if (!Number.isFinite(t) || Date.now() - t > STAGING_MOVE_REQUEST_TTL_MS) {
    session.stagingMoveRequest = undefined;
    publishLiveSnapshotEvent({ topic: "session", sessionId: session.id });
  }
}

export async function setTakeoffRequest(
  sessionId: string,
  request: { at: string; byUserId: string; label?: string }
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.takeoffRequest = request;
  session.countdownRequest = undefined;
  session.updatedAt = request.at;
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

/** Controller clears a pending takeoff ping (grant clearance or dismiss) without affecting the rocket countdown clock. */
export async function clearPendingTakeoffRequest(sessionId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (!session.takeoffRequest) return session;
  session.takeoffRequest = undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

/** Controller clears a pilot's launch-countdown request without starting or scrubbing an active count. */
export async function clearPendingCountdownRequest(sessionId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (!session.countdownRequest) return session;
  session.countdownRequest = undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

export async function setSessionStagingMove(
  sessionId: string,
  request: StagingMoveRequest
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  session.stagingMoveRequest = request;
  session.updatedAt = request.issuedAt;
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

export async function clearSessionStagingMove(sessionId: string): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  if (!session.stagingMoveRequest) return session;
  session.stagingMoveRequest = undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  return session;
}

/** Marks takeoff as cleared by tower (for cockpit HUD / telemetry echo). Not used on dismiss. */
export async function recordTakeoffClearanceGranted(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  const at = nowIso();
  session.takeoffClearanceAt = at;
  session.updatedAt = at;
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
}

export async function setSessionClearance(
  sessionId: string,
  clearance: ClearanceKind,
  status: "cleared" | "violation" | "neutral"
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const next: SessionClearances = { ...(session.clearances ?? {}) };
  if (status === "neutral") {
    delete next[clearance];
  } else {
    next[clearance] = status;
  }
  session.clearances = Object.keys(next).length ? next : undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  if (clearance === "TAKEOFF" && status === "cleared") {
    await clearPendingTakeoffRequest(sessionId);
    await recordTakeoffClearanceGranted(sessionId);
  }
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  publishLiveSnapshotEvent({ topic: "active-aircraft" });
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET clearances_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [session.clearances ? JSON.stringify(session.clearances) : null, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist clearances_json");
    }
  }
  return session;
}

export async function setExpectedLandingRunway(
  sessionId: string,
  runway: string | null | undefined
): Promise<SessionRecord | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const trimmed = runway?.trim();
  session.expectedLandingRunway = trimmed || undefined;
  session.updatedAt = nowIso();
  localSessions.set(session.id, session);
  publishLiveSnapshotEvent({ topic: "session", sessionId });
  publishLiveSnapshotEvent({ topic: "active-aircraft" });
  if (useDbPersistence()) {
    try {
      await withConn(async (conn) => {
        await conn.query(
          `
          UPDATE sessions
          SET expected_landing_runway = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [session.expectedLandingRunway ?? null, sessionId]
        );
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to persist expected_landing_runway");
    }
  }
  return session;
}

export async function listLogs(limit = 200): Promise<ActionLogRecord[]> {
  if (!useDbPersistence()) {
    return localLogs.slice(-Math.abs(limit)).reverse();
  }

  try {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = await withConn(async (conn) => {
      return (await conn.query(
        `
        SELECT id, actor_user_id, action_name, metadata_json, created_at
        FROM action_logs
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit]
      )) as Array<Record<string, unknown>>;
    });

    return rows.map((row) => ({
      id: String(row.id),
      at: new Date(String(row.created_at)).toISOString(),
      actorUserId: String(row.actor_user_id),
      action: String(row.action_name),
      metadata: safeJsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined)
    }));
  } catch {
    return localLogs.slice(-Math.abs(limit)).reverse();
  }
}
