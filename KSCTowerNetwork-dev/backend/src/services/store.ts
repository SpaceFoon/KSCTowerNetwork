import { randomUUID } from "node:crypto";

export type Role = "pilot" | "tower" | "supervisor" | "admin";
export type SessionStatus = "queued" | "assigned" | "active" | "closed";

/** One resource bucket aggregated across all parts on the vessel. */
export interface TelemetryResource {
  current: number;
  max: number;
}

/**
 * Counts block emitted by the publisher for parachutes / bays / deployables /
 * airbrakes. Specific keys vary by category (parachutes uses
 * armed/deployed/cut/total; deployables use deployed/total) — kept open as a
 * record so we don't have to fork an interface per category.
 */
export type TelemetryCounts = Record<string, number>;

/**
 * One Kerbalism life-support resource on a vessel: current / max amounts plus
 * the signed rate (positive = production, negative = consumption) and the
 * derived burn-down. `secondsRemaining` and `daysRemaining` are null when net
 * production is non-negative — there's no "remaining" to predict. Days are in
 * home-body days (Kerbin = 6 h; RSS Earth = 24 h) so the controller's reading
 * matches what KSP's own UI shows the player.
 */
export interface TelemetryLifeSupportResource {
  amount: number;
  max: number;
  ratePerSec: number;
  secondsRemaining: number | null;
  daysRemaining: number | null;
}

/**
 * One occupied seat on the vessel — stock-only stats so the crew expansion
 * works without Kerbalism. Per-kerbal Kerbalism dose lives separately in
 * `TelemetrySample.kerbalism.crew` so a stock save still gets the table.
 */
export interface TelemetryCrewMember {
  name: string;
  /** Localized trait title ("Pilot", "Engineer", "Scientist", "Tourist", …). */
  trait: string;
  /** ProtoCrewMember.type as a string ("Crew" | "Tourist" | "Unowned" | "Applicant"). */
  type: string;
  /** 0..5 in stock. */
  experienceLevel: number;
  /** Raw experience points. */
  experience: number;
  /** 0..1; high = brave (less likely to panic). */
  courage: number;
  /** 0..1; high = stupid (more likely to do dumb things). */
  stupidity: number;
  /** True for Jeb, Bill, Bob, Val and friends. */
  isVeteran: boolean;
  /** True for "badass" kerbals (won't panic). */
  isBadass: boolean;
}

export interface TelemetrySample {
  /** KSP vessel name (in-game ship name). */
  craftName?: string;
  /** Pilot callsign (same as account display name / `pilotName` in telemetry). */
  pilotName?: string;
  /** Session ATC callsign when denormalized onto telemetry samples. */
  callsign?: string;
  /** KSP vessel classification (e.g. Ship, Plane, Probe). */
  craftType?: string;
  /** Map marker: plane, surface rover, or rocket/default. */
  craftMapIcon?: "plane" | "rover" | "rocket";
  /**
   * Player-chosen "stock craft" silhouette key (e.g. "aeris4a"). Surfaced via
   * `/v1/tower/active-aircraft` so other plugins render this pilot's ghost as the chosen
   * craft. Empty / undefined falls back to `craftMapIcon` on the rendering side.
   */
  ghostCraftKey?: string;
  /**
   * Pilot opted out of being rendered as a ghost in other clients' tower views (the GHO
   * switch on the radio panel). Filtered server-side in `/v1/tower/active-aircraft`.
   */
  ghostOptOut?: boolean;
  /** Stable per-vessel id from KSP. Survives in-flight renames. */
  persistentId?: string;
  universalTime?: number;
  /** Mission Elapsed Time (seconds since launch on this vessel). */
  metSeconds?: number;
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
  /** Density-corrected indicated airspeed (m/s). Tower clearances use this, not surfaceSpeed. */
  indicatedAirSpeed?: number;
  /** Mach number from stock atmospheric model. */
  mach?: number;
  heading?: number;
  /** Ground track (deg); ghost DR uses this; nose heading is `heading`. */
  surfaceTrack?: number;
  pitch?: number;
  roll?: number;
  /** Angle of attack in degrees (between vessel forward and surface velocity). */
  aoa?: number;
  throttle?: number;
  /** Pilot-set trim, each axis -1..1. */
  trim?: { pitch: number; roll: number; yaw: number };
  // --- Action groups ---
  gearDown?: boolean;
  brakes?: boolean;
  lights?: boolean;
  rcs?: boolean;
  sas?: boolean;
  abort?: boolean;
  stage?: boolean;
  /** Custom action groups AG1..AG10, in order. Always exactly 10 entries when present. */
  customGroups?: boolean[];
  /** Stock SAS mode (e.g. StabilityAssist, Prograde, Retrograde, Target, Maneuver). */
  sasMode?: string;
  apoapsis?: number;
  periapsis?: number;
  gLoad?: number;
  /** Peak gLoad observed since this flight started (publisher-side high-water mark). */
  gLoadMax?: number;
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
  /** Total parts on the vessel right now. Consumer detects deltas (lost parts → damage event). */
  partsCount?: number;
  /**
   * True when any part is above 85% of its operational maxTemp. Legacy field —
   * new plugin builds also populate `temperature` below; consumers should
   * prefer deriving overheat from `max(temperature.*MaxRatio) > 0.85`.
   */
  overheating?: boolean;
  /**
   * Structured temperature block (see COCKPIT_INSTRUMENTS_PLAN.md §2).
   * `engineMaxRatio`/`skinMaxRatio`/`internalMaxRatio` are 0..1+ ratios across
   * the whole airframe (>1 briefly possible during reentry). `externalC`/
   * `atmosphericC` are Celsius. `hotPart` is the worst-offender callout above
   * the 0.70 warning threshold, or null otherwise. Absent on old plugin builds.
   */
  temperature?: {
    engineMaxRatio: number;
    skinMaxRatio: number;
    internalMaxRatio: number;
    externalC: number;
    atmosphericC: number;
    hotPart: {
      name: string;
      ratio: number;
      kind: "skin" | "internal" | "engine";
    } | null;
  };
  /** True when a docking node on this vessel is in any Docked* / PreAttached state. */
  docked?: boolean;
  /** True when the active vessel is a kerbal on EVA. */
  isEva?: boolean;
  /** EVA propellant remaining as a 0..1 ratio. Only meaningful when isEva. */
  evaPropellant?: number;
  /** Engines aggregated across all stock ModuleEngines on the vessel. */
  engines?: {
    count: number;
    lit: number;
    flameouts: number;
    totalThrustKn: number;
    twr: number;
  };
  /**
   * Resources the vessel currently carries. Keys are camelCase for stock
   * (liquidFuel, oxidizer, monoPropellant, electricCharge, intakeAir, etc.);
   * modded resources fall through under their stock-style name.
   */
  resources?: Record<string, TelemetryResource>;
  parachutes?: TelemetryCounts;
  bays?: TelemetryCounts;
  solarPanels?: TelemetryCounts;
  antennas?: TelemetryCounts;
  radiators?: TelemetryCounts;
  /** Stock airbrakes only (ModuleAeroSurface excluding ModuleControlSurface). */
  airbrakes?: TelemetryCounts;
  /** FAR / Ferram Aerospace Research surface state. Absent when FAR isn't installed. */
  far?: {
    available: boolean;
    flap: number;
    spoiler: boolean;
  };
  /**
   * Selected vessel target. Null = no target OR target is a body/waypoint (the
   * publisher deliberately ignores non-vessel targets for ATC use).
   */
  target?: {
    name: string;
    distanceM: number;
    bearingDeg: number;
    closureRateMs: number;
  } | null;
  /**
   * Live status of each optional pilot feed (beacon, kOS terminal stream,
   * HullCam JRTI relay, voice bridge process). Each field is sourced from the
   * subsystem that owns it and snapshotted into every telemetry tick so the
   * tower can show "what's this pilot serving right now" without polling N
   * endpoints. `beacon` is always true here — the beacon-off case is
   * communicated through the separate telemetry-status edge POST instead.
   */
  subsystems?: {
    beacon: boolean;
    kosStream: boolean;
    hullcam: {
      enabled: boolean;
      available: boolean;
      cameraCount: number;
    };
    voiceBridge: boolean;
  };
  /** Kerbalism radiation in rad/s when Kerbalism is installed. Kept top-level for one release of back-compat; prefer `kerbalism.radiation` (when present) on read going forward. */
  radiation?: number;
  /** True when Kerbalism radiation reading is present. */
  radiationAvailable?: boolean;
  /**
   * True when the plugin reached the Kerbalism API at all (any sub-method
   * succeeded). The `kerbalism` block below is only emitted when this is true.
   * See KERBALISM_TELEMETRY_PLAN.md §2 for the namespace migration plan.
   */
  kerbalismAvailable?: boolean;
  /**
   * Kerbalism life-support / per-crew dose / storm window. Brought forward
   * from KERBALISM_TELEMETRY_PLAN.md Phase 4 onto the Tower Desk so the
   * controller can read "days of food / water / O2 left" without waiting on
   * the deferred CapCom seat from MISSION_OPS_SEATS_PLAN.md. Each sub-block
   * is independently optional — an old Kerbalism build without `StormIncoming`
   * still publishes `lifeSupport` and `crew`.
   */
  kerbalism?: {
    /**
     * Per-resource burn-down. Keys are camelCase (food, water, oxygen,
     * nitrogen, atmosphere, wasteAtmosphere, carbonDioxide). `secondsRemaining`
     * and `daysRemaining` are null when net production ≥ 0 (the resource
     * isn't depleting). `daysRemaining` is in home-body days, so a 1-day
     * Kerbin reading and a 1-day RSS Earth reading mean different real durations
     * — match what KSP shows the player in-game.
     */
    lifeSupport?: Record<string, TelemetryLifeSupportResource>;
    /** Per-crew Kerbalism radiation dose. Empty when no Radiation(ProtoCrewMember) overload. */
    crew?: Array<{ name: string; doseRad: number }>;
    /** Solar storm window for the vessel's main body. */
    storm?: { incoming: boolean; durationSec?: number };
  };
  /**
   * Per-kerbal stock stats array, parallel to `crewNames`. Always emitted by
   * new plugin builds regardless of Kerbalism so the Tower's crew expansion
   * works on stock saves. Older plugin builds omit this — consumer falls back
   * to `crewNames` for those.
   */
  crewStats?: TelemetryCrewMember[];
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
}

export interface SessionRecord {
  id: string;
  pilotUserId: string;
  assignedTowerUserId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  blockedUserIds: string[];
  telemetry?: TelemetrySample;
  radioState?: {
    busy: boolean;
    blocked: boolean;
    freqMhz?: number;
    transmitterSessionId?: string;
    transmitterCallsign?: string;
    startedAtMs?: number;
    updatedAtMs: number;
    expiresAtMs?: number;
    blockedAtMs?: number;
    blockedBySessionId?: string;
    blockedByCallsign?: string;
    blockedWithSessionId?: string;
    blockedWithCallsign?: string;
    message?: string;
  };
}

export interface ReportRecord {
  id: string;
  reporterUserId: string;
  targetUserId?: string;
  sessionId?: string;
  reason: string;
  createdAt: string;
}

const towerQueue = new Set<string>();
const sessions = new Map<string, SessionRecord>();
const reports: ReportRecord[] = [];
const bans = new Set<string>();
const actionLogs: Array<{ id: string; at: string; actorUserId: string; action: string; metadata?: Record<string, unknown> }> = [];

function nowIso(): string {
  return new Date().toISOString();
}

export function joinTowerQueue(userId: string): { size: number } {
  towerQueue.add(userId);
  return { size: towerQueue.size };
}

export function leaveTowerQueue(userId: string): { size: number } {
  towerQueue.delete(userId);
  return { size: towerQueue.size };
}

export function nextTowerExcluding(excluded: Set<string>): string | undefined {
  for (const userId of towerQueue) {
    if (!excluded.has(userId) && !bans.has(userId)) {
      return userId;
    }
  }
  return undefined;
}

export function createSession(pilotUserId: string): SessionRecord {
  const id = randomUUID();
  const record: SessionRecord = {
    id,
    pilotUserId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    blockedUserIds: []
  };
  sessions.set(id, record);
  return record;
}

export function assignTower(sessionId: string, towerUserId: string): SessionRecord | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.assignedTowerUserId = towerUserId;
  session.status = "assigned";
  session.updatedAt = nowIso();
  return session;
}

/**
 * Vacate the tower seat without rotating to a new controller. Used by the
 * release-tower endpoint (self-release "Stand down" or mod-initiated kick).
 *
 * Status is moved back to "queued" because the room exists and a pilot is in
 * it, but no controller is currently sitting in the seat — that's the same
 * shape a brand-new session has between createSession() and the first
 * claimNextTowerForSession() success, so existing UI/lobby code doesn't need
 * a third status value to handle "abandoned".
 *
 * No-op (returns the session unchanged) when no tower is currently assigned —
 * lets callers skip a guard and stay idempotent under double-clicks /
 * pagehide beacon races.
 */
export function clearAssignedTower(sessionId: string): SessionRecord | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (!session.assignedTowerUserId) return session;

  session.assignedTowerUserId = undefined;
  session.status = "queued";
  session.updatedAt = nowIso();
  return session;
}

export function rotateNextTower(sessionId: string): SessionRecord | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const excluded = new Set<string>([
    ...session.blockedUserIds,
    ...(session.assignedTowerUserId ? [session.assignedTowerUserId] : [])
  ]);

  const next = nextTowerExcluding(excluded);
  if (!next) return session;

  session.assignedTowerUserId = next;
  session.updatedAt = nowIso();
  return session;
}

export function blockUserForSession(sessionId: string, blockedUserId: string): SessionRecord | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (!session.blockedUserIds.includes(blockedUserId)) {
    session.blockedUserIds.push(blockedUserId);
  }
  session.updatedAt = nowIso();
  return session;
}

export function setTelemetry(sessionId: string, telemetry: TelemetrySample): SessionRecord | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  session.telemetry = telemetry;
  session.updatedAt = nowIso();
  return session;
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return sessions.get(sessionId);
}

export function addReport(record: Omit<ReportRecord, "id" | "createdAt">): ReportRecord {
  const item: ReportRecord = {
    id: randomUUID(),
    createdAt: nowIso(),
    ...record
  };
  reports.push(item);
  return item;
}

export function listReports(): ReportRecord[] {
  return [...reports].reverse();
}

export function banUser(userId: string): void {
  bans.add(userId);
  towerQueue.delete(userId);
}

export function listBans(): string[] {
  return Array.from(bans);
}

export function logAction(actorUserId: string, action: string, metadata?: Record<string, unknown>): void {
  actionLogs.push({
    id: randomUUID(),
    at: nowIso(),
    actorUserId,
    action,
    metadata
  });
}

export function listLogs(limit = 200): Array<{ id: string; at: string; actorUserId: string; action: string; metadata?: Record<string, unknown> }> {
  return actionLogs.slice(-Math.abs(limit)).reverse();
}
