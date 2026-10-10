import express, { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { safeStr } from "../lib/safeText";
import { logger } from "../lib/logger";
import { readLogEntries, type ServerLogLevel } from "../lib/serverLogBuffer";
import { env, getLiveKitWsUrl } from "../config/env";
import { RADIO_QUICK_PRESETS } from "../config/radioPresets";
import {
  effectiveRole,
  loadIpBan,
  requireAdmin,
  requireAuth,
  requireCapability,
  requireRole,
  userRoleFlags
} from "../middleware/auth";
import {
  authLimiter,
  heavyPublishLimiter,
  hullcamLimiter,
  pluginExchangeLimiter,
  telemetryLimiter,
  writeLimiter
} from "../middleware/rateLimit";
import {
  baseCookieOptions,
  csrfCookieOptions,
  CSRF_COOKIE_NAME,
  csrfGuard,
  generateCsrfToken,
  SESSION_COOKIE_NAME
} from "../middleware/csrf";
import { createGuestSession } from "../services/guestAuth";
import {
  clearKickCooldown,
  ensureLiveKitRoom,
  getKickCooldownRemainingSec,
  isBridgeIdentity,
  issueLiveKitToken,
  isLiveKitConfigured,
  kickIdentityFromAllRooms,
  kickIdentityFromRoom,
  listKickCooldowns,
  restorePublishForIdentity,
  revokePublishForIdentity,
  setPublishForRoomParticipants
} from "../services/livekit";
import { exchangePluginToken, issueExchangeCode } from "../services/pluginAuth";
import { authenticateWebUser, issueWebSessionToken, resolveWebSessionDisplayName } from "../services/webAuth";
import {
  registerUser,
  changeRegisteredUserPassword,
  adminResetRegisteredUserPassword,
  isRegisteredUserId,
  type RegisterRequest as RegisterUserRequest
} from "../services/registeredUsers";
import {
  consumeInviteCode,
  createInviteCode,
  listInviteCodes,
  revokeInviteCode
} from "../services/inviteCodes";
import {
  ackChecklistSend,
  addSessionChecklistItem,
  addSessionChecklistPhase,
  addSessionSpectator,
  appendDirectMessage,
  appendKosScreenLine,
  appendLobbyMessage,
  addReport,
  appendSessionMessage,
  assignTower,
  boothLiveKitRoomName,
  boothThreadId,
  awardEvent,
  banGuestIp,
  banUser,
  blockUserForSession,
  capabilitiesFor,
  checklistSideComplete,
  claimNextTowerForSession,
  clearAssignedTower,
  clearCountdown,
  clearPendingCountdownRequest,
  clearPendingTakeoffRequest,
  closeSession,
  createChecklistTemplate,
  deleteChecklistTemplate,
  ensureLocalRoleSeeded,
  evaluateAndApplyAutoRules,
  findOpenSessionByFrequency,
  getChecklistSend,
  getChecklistTemplate,
  getGuestById,
  getSessionBoothMuted,
  getSessionScorecard,
  getUserAccess,
  getUserProfile,
  getOrCreateServerRadioSessionByFrequency,
  getSession,
  getSessionWithDevSharedBootstrap,
  getTowerQueueStatus,
  isServerOwnedRadioSessionId,
  joinTowerQueue,
  latestChecklistSend,
  leaveTowerQueue,
  listAdminPrincipals,
  listBans,
  listChecklistTemplates,
  listDirectMessagePeers,
  listDirectMessages,
  listDirectMessageThreads,
  listKosScreenLines,
  listLobbyMessages,
  listLogs,
  listReports,
  listChatRoomSummariesAdmin,
  listSessionMessages,
  listSessionsMerged,
  listUserModerationHistory,
  getDisplayNameOverride,
  setUserDisplayName,
  logAction,
  muteUser,
  unbanUser,
  unmuteUser,
  type BanListEntry,
  nextTowerExcluding,
  recordChecklistSend,
  recordTakeoffClearanceGranted,
  removeSessionChecklistItem,
  removeSessionChecklistPhase,
  removeSessionSpectator,
  renameSessionChecklistItem,
  SessionClosedError,
  setSessionPilot,
  opsLiveKitRoomName,
  renameSessionChecklistPhase,
  reorderSessionChecklistPhases,
  roleAtLeast,
  rotateNextTower,
  ROLE_RANK,
  sanitizeChecklistPhases,
  addSessionSharedWaypoint,
  acknowledgeSessionDragonRadarCrewRevive,
  claimSessionDragonBall,
  DRAGON_RADAR_RULES,
  getDragonRadarRules,
  getSessionDragonRadarGame,
  removeSessionSharedWaypoint,
  resolveSessionDragonRadarCombat,
  setSessionBoothMuted,
  setSessionChecklistPhases,
  setSessionName,
  setCountdownRequest,
  setTakeoffRequest,
  setSessionClearance,
  setExpectedLandingRunway,
  pruneStaleTakeoffRequest,
  pruneStaleStagingMoveRequest,
  clearSessionStagingMove,
  setSessionStagingMove,
  setTelemetry,
  setTelemetryStatus,
  setUserRole,
  startSessionDragonRadarGame,
  startCountdown,
  toggleChecklistItem,
  updateChecklistTemplate,
  withDerivedRoomLabels,
  type ChecklistPhaseDef,
  type ChecklistSendRecord,
  type ChecklistState,
  type ChecklistTemplateInput,
  type Role,
  type SessionRecord,
  type TelemetryHealthState,
  type TelemetryStatusEvent
} from "../services/repository";
import { DEFAULT_CHECKLIST_PHASES } from "../services/defaultChecklist";
import { emitChecklistEvent, subscribeChecklistEvents } from "../services/checklistEvents";
import { detectFromTelemetry } from "../services/scoring";
import {
  getWorldInventory,
  setWorldInventory,
  worldInventorySchema
} from "../services/worldInventory";
import {
  getWorldMaps,
  getWorldMapsLayer,
  setWorldMaps,
  UnsafeSvgError,
  WorldMapsTooLargeError,
  worldMapsSchema
} from "../services/worldMaps";
import {
  HULLCAM_STALE_MS,
  KSC_TOWER_SESSION_PREFIX,
  getFrame as getHullCamFrame,
  isKscTowerSessionId,
  listActiveSessionIds as listActiveHullCamSessionIds,
  listCameras as listHullCamCameras,
  putFrame as putHullCamFrame
} from "../services/hullcamStore";
import { getOptimizedJpeg, getWebp } from "../services/hullcamCompress";
import { CRAFT_THUMBNAIL_MAX_BYTES, normalizeCraftThumbnail, putCraftThumbnail, getCraftThumbnail } from "../services/craftThumbnailStore";
import {
  VESSEL_MANIFEST_IDLE_TTL_MS,
  getManifest as getVesselManifest,
  putManifest as putVesselManifest
} from "../services/vesselManifestStore";
import { forceAdvanceAtis, getAtisCurrentForClient, regenAtisCache } from "../services/atis";
import { renderAtisPreviewAudio } from "../services/atisPreviewAudio";
import { publishLiveSnapshotEvent } from "../live/liveSnapshotBus";
import { clearancePostSchema, expectedRunwaySchema, runwayOccupancyPostSchema } from "../tower/clearanceTypes";
import { STAGING_MOVE_PRESETS, stagingMoveIssueSchema } from "../tower/stagingMoveTypes";
import { runTowerTelemetryHooks } from "../tower/afterTelemetry";
import { buildTelemetryReplyPayload } from "../tower/telemetryReplyPayload";
import { setRunwayManualOverride } from "../tower/runwayState";
import { getLiveMetricsSnapshot, incLiveMetric } from "../live/metrics";
import {
  getActiveAircraftSnapshot,
  getSessionMessagesSnapshot,
  getSessionSnapshot,
  getTowerViewStreamsSnapshot
} from "../live/snapshotCache";

const DEFAULT_RADIO_CALL_FREQUENCY_MHZ =
  RADIO_QUICK_PRESETS.find((preset) => preset.id === "twr")?.frequencyMhz ?? "122.000";

const callSchema = z.object({
  kind: z.literal("tower").default("tower"),
  craftName: z.string().min(1).max(120).optional(),
  // Human-set lobby room name (e.g. "Bobcat 7 morning practice"). When omitted/empty,
  // the lobby UI falls back to `tower-{sessionId}`. Sanitization (trim, control-strip,
  // 80-char cap) happens in repository.sanitizeRoomName during createSession.
  // Cap here is generous on purpose; the repository does the real bounds enforcement.
  name: z.string().max(200).optional(),
  // Optional VHF frequency the in-game radio dialed when minting this room.
  // When supplied (and valid 118.000-136.975 MHz on 25 kHz spacing) the row's
  // `frequency_mhz` is set to it; otherwise `defaultFrequencyMhz()` derives a
  // hash. Without this the lobby would show the typed digits as the room name
  // ("122.000") while frequencyMhz was the unrelated hash ("128.175"), giving
  // the confusing "LISTEN 122.000 / 128.175 MHz" card.
  frequencyMhz: z
    .string()
    .regex(/^[0-9]{3}\.[0-9]{3}$/, "Expected NNN.NNN")
    .optional()
});

const claimPilotSchema = z
  .object({
    sessionId: z.string().min(1).max(120).optional(),
    frequencyMhz: z
      .string()
      .regex(/^[0-9]{3}\.[0-9]{3}$/, "Expected NNN.NNN")
      .optional(),
    name: z.string().max(200).optional()
  })
  .refine((v) => v.sessionId || v.frequencyMhz, {
    message: "Provide either sessionId or frequencyMhz"
  });

const renameRoomSchema = z.object({
  // Pass null (or empty string) to clear the name and revert the lobby card to
  // `tower-{sessionId}`. Anything else is sanitized + 80-char-capped server-side.
  name: z.string().max(200).nullable()
});

// Helper: every numeric telemetry field must be a real, finite number.
// Without `.finite()` Zod accepts Infinity/-Infinity/NaN, which then poison
// downstream scoring, cadence math, and JSON.stringify (NaN -> null).
const finiteNum = () => z.number().finite();
const finiteInt = () => z.number().int().finite();

// Reused sub-schemas for nested telemetry blocks. Each is `.optional()` at the
// call site so the plugin can omit blocks that don't apply to the current
// vessel (e.g. `far` is omitted when FAR isn't installed; `target` is `null`
// when no vessel target is set).
const resourceSchema = z.object({
  current: finiteNum().nonnegative(),
  max: finiteNum().nonnegative()
});

const countSchema = (extraKeys: Record<string, z.ZodTypeAny> = {}) =>
  z
    .object({
      ...extraKeys
    })
    .catchall(finiteInt().nonnegative().max(10_000));

const telemetrySchema = z.object({
  craftName: z.string().max(120).optional(),
  pilotName: z.string().max(120).optional(),
  /** Session ATC callsign; server prefers the session row when present. */
  callsign: z.string().max(64).optional(),
  /** KSP vessel classification (e.g. Ship, Plane, Probe). */
  craftType: z.string().max(64).optional(),
  /** Map marker shape: plane, landed wheel craft (rover), or rocket/default. */
  craftMapIcon: z.enum(["plane", "rover", "rocket"]).optional(),
  /**
   * Player-chosen "stock craft" silhouette key the in-game ghost-fleet renders as the
   * outward livery for this pilot. Free-form short string (the plugin maintains the
   * canonical roster); empty = let the receiver auto-detect from `craftMapIcon`.
   */
  ghostCraftKey: z.string().max(32).optional(),
  /**
   * Pilot opted out of the ghost-fleet presence layer (the radio panel's GHO switch).
   * When true, `/v1/tower/active-aircraft` strips this session from the response so the
   * pilot doesn't render in other clients' tower views. The controller's strip and
   * scoring still see telemetry — only the cosmetic "see other players" feed is muted.
   */
  ghostOptOut: z.boolean().optional(),
  /** Stable per-vessel id from KSP. Survives in-flight renames; correlation key for strips. */
  persistentId: z.string().max(40).optional(),
  universalTime: finiteNum().optional(),
  /** Mission Elapsed Time (seconds since launch on this vessel). */
  metSeconds: finiteNum().nonnegative().optional(),
  bodyName: z.string().max(64).optional(),
  situation: z.string().max(64).optional(),
  /** KSP biome under the vessel (e.g. "Shores", "Highlands"). Empty when the body has no biome map. */
  biome: z.string().max(120).optional(),
  lat: finiteNum().min(-90).max(90).optional(),
  lon: finiteNum().min(-360).max(360).optional(),
  radarAlt: finiteNum().optional(),
  aslAlt: finiteNum().optional(),
  surfaceSpeed: finiteNum().optional(),
  verticalSpeed: finiteNum().optional(),
  /** Density-corrected indicated airspeed (m/s). Tower clearances use this, not surfaceSpeed. */
  indicatedAirSpeed: finiteNum().nonnegative().optional(),
  /** Mach number from stock atmospheric model. */
  mach: finiteNum().nonnegative().optional(),
  heading: finiteNum().min(-360).max(720).optional(),
  /** Ground track (deg CW from north); nose heading is `heading`. */
  surfaceTrack: finiteNum().min(-360).max(720).optional(),
  pitch: finiteNum().min(-180).max(180).optional(),
  roll: finiteNum().min(-360).max(360).optional(),
  aoa: finiteNum().min(-180).max(180).optional(),
  throttle: finiteNum().min(0).max(1).optional(),
  /** Pilot-set trim, each axis -1..1. */
  trim: z
    .object({
      pitch: finiteNum().min(-1).max(1),
      roll: finiteNum().min(-1).max(1),
      yaw: finiteNum().min(-1).max(1)
    })
    .optional(),
  // --- Action groups: legacy flat booleans + the missing pieces ---
  gearDown: z.boolean().optional(),
  brakes: z.boolean().optional(),
  lights: z.boolean().optional(),
  rcs: z.boolean().optional(),
  sas: z.boolean().optional(),
  abort: z.boolean().optional(),
  stage: z.boolean().optional(),
  /** Custom action groups AG1..AG10, in order. Always exactly 10 entries when present. */
  customGroups: z.array(z.boolean()).length(10).optional(),
  /** Stock SAS mode (e.g. StabilityAssist, Prograde, Retrograde, Target, Maneuver). */
  sasMode: z.string().max(32).optional(),
  apoapsis: finiteNum().optional(),
  periapsis: finiteNum().optional(),
  gLoad: finiteNum().optional(),
  /** Peak gLoad observed since this flight started (publisher-side high-water mark). */
  gLoadMax: finiteNum().optional(),
  wetMass: finiteNum().nonnegative().optional(),
  dryMass: finiteNum().nonnegative().optional(),
  crewCurrent: finiteInt().nonnegative().max(1024).optional(),
  crewCapacity: finiteInt().nonnegative().max(1024).optional(),
  crewNames: z.array(z.string().max(120)).max(64).optional(),
  /** Total parts on the vessel right now. Consumer detects deltas (lost parts → damage event). */
  partsCount: finiteInt().nonnegative().max(10_000).optional(),
  /**
   * True when any part is above 85% of its operational maxTemp. Drives
   * "OVERHEAT" caution. Kept for back-compat with old plugin builds; new
   * builds also populate `temperature` below, and consumers should prefer
   * deriving overheat from `max(temperature.*MaxRatio) > 0.85`.
   */
  overheating: z.boolean().optional(),
  /**
   * Structured temperature block (see COCKPIT_INSTRUMENTS_PLAN.md §2). Three
   * max-ratio buckets across the whole airframe (0..1+ — clamping to 1.0 is a
   * UI concern, not a wire concern; reentry can briefly read >1), the ambient
   * external/atmospheric temperatures in Celsius, and an optional hot-part
   * callout for the controller's "HOT: <name>" caption when something is
   * above the 0.70 warning threshold. Absent from old plugin builds.
   */
  temperature: z
    .object({
      engineMaxRatio: finiteNum().nonnegative(),
      skinMaxRatio: finiteNum().nonnegative(),
      internalMaxRatio: finiteNum().nonnegative(),
      externalC: finiteNum(),
      atmosphericC: finiteNum(),
      hotPart: z
        .object({
          name: z.string().max(120),
          ratio: finiteNum().nonnegative(),
          kind: z.enum(["skin", "internal", "engine"])
        })
        .nullable()
    })
    .optional(),
  /** True when a docking node on this vessel is in any Docked* / PreAttached state. */
  docked: z.boolean().optional(),
  /** True when the active vessel is a kerbal on EVA (its own vessel in stock KSP). */
  isEva: z.boolean().optional(),
  /** EVA propellant remaining as a 0..1 ratio. Only meaningful when isEva. */
  evaPropellant: finiteNum().min(0).max(1).optional(),
  /** Engines block: stock ModuleEngines aggregates across the whole vessel. */
  engines: z
    .object({
      count: finiteInt().nonnegative().max(1024),
      lit: finiteInt().nonnegative().max(1024),
      flameouts: finiteInt().nonnegative().max(1024),
      totalThrustKn: finiteNum().nonnegative(),
      twr: finiteNum().nonnegative()
    })
    .optional(),
  /**
   * Resources the vessel currently carries. Keys are camelCase for stock
   * resources (liquidFuel, oxidizer, monoPropellant, electricCharge, intakeAir,
   * solidFuel, xenonGas, ablator, ore, evaPropellant). Modded resources fall
   * through under their stock-style name. We don't lock the keyset — letting
   * unknown mods publish "Karbonite" etc. is more useful than 400-erroring on
   * them.
   */
  resources: z.record(z.string().max(64), resourceSchema).optional(),
  /** Parachute counts across the vessel. */
  parachutes: countSchema().optional(),
  /** Cargo + service bays. `open` includes any bay that isn't ClosedAndLocked. */
  bays: countSchema().optional(),
  solarPanels: countSchema().optional(),
  antennas: countSchema().optional(),
  radiators: countSchema().optional(),
  /** Stock airbrakes only (ModuleAeroSurface excluding ModuleControlSurface). */
  airbrakes: countSchema().optional(),
  /** FAR / Ferram Aerospace Research surface state. Omitted entirely when FAR isn't installed. */
  far: z
    .object({
      available: z.boolean(),
      flap: finiteInt().min(0).max(3),
      spoiler: z.boolean()
    })
    .optional(),
  /**
   * Currently selected vessel target (if any). `null` means no target set OR
   * target is a body / waypoint (we deliberately ignore those for ATC use).
   */
  target: z
    .object({
      name: z.string().max(120),
      distanceM: finiteNum().nonnegative(),
      bearingDeg: finiteNum().min(-360).max(720),
      closureRateMs: finiteNum()
    })
    .nullable()
    .optional(),
  /**
   * Which of the pilot's optional feeds are currently live. Each field has a
   * single source of truth in the plugin — the publisher just snapshots them
   * each tick so the tower can render a "feeds" pill without polling separate
   * endpoints. `beacon` is always `true` when present because the beacon-off
   * case suppresses the telemetry POST entirely (see telemetryStatusSchema's
   * `beacon_off`). `hullcam.enabled` is the pilot's master toggle while
   * `hullcam.available` reflects whether JRTI's local listener is responding.
   */
  subsystems: z
    .object({
      beacon: z.boolean(),
      kosStream: z.boolean(),
      hullcam: z.object({
        enabled: z.boolean(),
        available: z.boolean(),
        cameraCount: finiteInt().nonnegative().max(64)
      }),
      voiceBridge: z.boolean()
    })
    .optional(),
  radiation: finiteNum().optional(),
  radiationAvailable: z.boolean().optional(),
  /**
   * Kerbalism Phase 4 (KERBALISM_TELEMETRY_PLAN.md) brought forward onto the
   * Tower Desk: life-support resource burn-down, per-crew radiation dose, and
   * storm window. Top-level capability flag stays even when the namespaced
   * block is absent so consumers can render "Kerbalism not installed" without
   * a probe.
   */
  kerbalismAvailable: z.boolean().optional(),
  kerbalism: z
    .object({
      lifeSupport: z
        .record(
          z.string().max(64),
          z.object({
            amount: finiteNum().nonnegative(),
            max: finiteNum().nonnegative(),
            ratePerSec: finiteNum(),
            // null when net production is non-negative (resource isn't depleting).
            secondsRemaining: finiteNum().nonnegative().nullable(),
            daysRemaining: finiteNum().nonnegative().nullable()
          })
        )
        .optional(),
      crew: z
        .array(
          z.object({
            name: z.string().max(120),
            doseRad: finiteNum()
          })
        )
        .max(64)
        .optional(),
      storm: z
        .object({
          incoming: z.boolean(),
          durationSec: finiteNum().nonnegative().optional()
        })
        .optional()
    })
    .optional(),
  /**
   * Per-kerbal stock stats. Trait/level/courage/stupidity/veteran/badass.
   * Always emitted by new plugin builds; older builds omit and the UI falls
   * back to `crewNames`.
   */
  crewStats: z
    .array(
      z.object({
        name: z.string().max(120),
        trait: z.string().max(64),
        type: z.string().max(32),
        experienceLevel: finiteInt().min(0).max(10),
        experience: finiteNum().nonnegative(),
        courage: finiteNum().min(0).max(1),
        stupidity: finiteNum().min(0).max(1),
        isVeteran: z.boolean(),
        isBadass: z.boolean()
      })
    )
    .max(64)
    .optional(),
  commNetAvailable: z.boolean().optional(),
  commLink: z.boolean().optional(),
  commLinkHome: z.boolean().optional(),
  commSignal: finiteNum().min(0).max(1).optional(),
  targetRunway: z.string().max(64).optional(),
  /** Wall-clock sample time (UTC epoch ms). Additive presentation aid. */
  sampleUnixMs: finiteNum().nonnegative().optional(),
  smoothedPositionValid: z.boolean().optional(),
  smoothedLat: finiteNum().min(-90).max(90).optional(),
  smoothedLon: finiteNum().min(-360).max(360).optional(),
  smoothedAslAlt: finiteNum().optional(),
  /** Surface-relative velocity in the local ENU frame (m/s). */
  srfVelNorth: finiteNum().optional(),
  srfVelEast: finiteNum().optional(),
  srfVelUp: finiteNum().optional(),
  /** Kerbin-only: great-circle distance to nearest KSC-sector aerodrome ref (m). */
  distKSC: finiteNum().nonnegative().optional(),
  bearingKSC: finiteNum().min(-360).max(720).optional(),
  /** Degrees off the active runway inbound heading (0..180). */
  alignErr: finiteNum().min(0).max(180).optional(),
  activeRunway: z.string().max(8).optional(),
  kscAerodrome: z.string().max(8).optional(),
  onApproach: z.boolean().optional(),
  landing: z.boolean().optional(),
  flightPhase: z.string().max(16).optional(),
  touchdownEtaSec: finiteNum().nonnegative().optional(),
  fuelLow: z.boolean().optional(),
  radioFreqMhz: finiteNum().min(108).max(137).optional(),
  radioPtt: z.boolean().optional()
});

/**
 * Plugin-pushed "going dark" reason. The plugin posts this whenever it's choosing
 * not to send a telemetry sample so the controller's UI can stop pretending the
 * frozen last-sample is fresh data. `live` is implicit (set on every successful
 * `/telemetry` POST) and `stale` is derived server-side, so neither is accepted
 * here — pushing them would be a category error.
 */
const telemetryStatusSchema = z.object({
  state: z.enum(["beacon_off", "paused", "scene_left", "warp", "vessel_dead", "vessel_switch"]),
  message: z.string().max(200).optional()
});

/**
 * Wall-clock seconds since the most recent successful `/telemetry` POST. Used to
 * decide whether the controller should be told the stream is live, paused for a
 * known reason, or silently dead (KSP CTD / network drop). The 3× cadence
 * threshold matches what an attentive controller would notice anyway: at the
 * default 5s cadence we light up "stale" after ~15s of silence, and at the
 * close-approach 1s cadence after ~3s.
 */
function telemetryAgeSeconds(session: SessionRecord, nowMs: number): number | null {
  if (!session.lastTelemetryAt) return null;
  const t = Date.parse(session.lastTelemetryAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function deriveTelemetryHealth(session: SessionRecord): {
  state: TelemetryHealthState;
  ageSeconds: number | null;
  lastTelemetryAt: string | null;
  reason?: TelemetryStatusEvent;
  staleThresholdSeconds: number;
} {
  const nowMs = Date.now();
  const cadence =
    (session.telemetry?.radarAlt ?? Number.POSITIVE_INFINITY) < env.TELEMETRY_CLOSE_AGL_M
      ? env.TELEMETRY_CLOSE_SECONDS
      : env.TELEMETRY_DEFAULT_SECONDS;
  // Allow up to ~3 missed cycles before flipping to "stale" so a single dropped
  // packet on a noisy network doesn't paint a scary banner. Floor at 5s so the
  // 1s close-approach cadence doesn't false-positive on every coroutine hiccup.
  const staleThresholdSeconds = Math.max(5, Math.ceil(cadence * 3));
  const ageSeconds = telemetryAgeSeconds(session, nowMs);
  const lastTelemetryAt = session.lastTelemetryAt ?? null;

  // Plugin-reported reason wins as long as it isn't itself stale (plugin crashed
  // *after* sending "beacon_off" without ever resuming).
  const explicit = session.telemetryStatus;
  if (explicit) {
    const explicitAtMs = Date.parse(explicit.at);
    const explicitAgeSeconds = Number.isFinite(explicitAtMs)
      ? Math.max(0, Math.floor((nowMs - explicitAtMs) / 1000))
      : ageSeconds;
    if (explicitAgeSeconds == null || explicitAgeSeconds <= staleThresholdSeconds) {
      return { state: explicit.state, ageSeconds, lastTelemetryAt, reason: explicit, staleThresholdSeconds };
    }
  }

  if (!session.lastTelemetryAt) {
    // Never received any telemetry — distinct from "lost contact". The web UI
    // already renders its own "no telemetry yet" empty state for this; report
    // `live` so we don't double-paint.
    return { state: "live", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
  }

  if (ageSeconds != null && ageSeconds > staleThresholdSeconds) {
    return { state: "stale", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
  }

  return { state: "live", ageSeconds, lastTelemetryAt, staleThresholdSeconds };
}

const reportSchema = z.object({
  targetUserId: z.string().max(120).optional(),
  sessionId: z.string().max(120).optional(),
  reason: safeStr(1000).pipe(z.string().min(3))
});

const exchangeSchema = z.object({
  code: z.string().min(8)
});

/** Pilot-facing label: `callsign` and `displayName` are the same field (callsign wins if both are set). */
function pilotLabelFromAuthBody(body: { displayName?: string; callsign?: string }): string | undefined {
  const cs =
    typeof body.callsign === "string" && body.callsign.trim().length > 0 ? body.callsign.trim() : undefined;
  const dn =
    typeof body.displayName === "string" && body.displayName.trim().length > 0
      ? body.displayName.trim()
      : undefined;
  return cs ?? dn;
}

const webLoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  displayName: safeStr(120).optional(),
  callsign: safeStr(120).optional()
});

// /v1/auth/register: tighter than login because we have to be opinionated about
// what "valid" looks like at *create* time. Login can accept anything that
// authenticates against an existing record (including legacy plaintext); new
// signups have to clear a real bar.
//   - password: min 8, max 200. Below 8 is a footgun; above 200 is a DoS surface
//     for argon2 hashing.
//   - callsign / displayName: same field — at least one required at signup so
//     every account has a stable pilot label in voice rooms and chat. Login
//     can omit both because the existing record already has one.
//   - inviteCode: case-insensitive, 8-64 chars (matches what /admin/invite-codes
//     mints). Optional in mode `open` / `open_or_invite`, required in
//     `invite_only`.
const webRegisterSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(200),
    displayName: safeStr(120).optional(),
    callsign: safeStr(120).optional(),
    inviteCode: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/u, "inviteCode contains unsupported characters")
      .optional()
  })
  .superRefine((data, ctx) => {
    if (!pilotLabelFromAuthBody(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Callsign is required",
        path: ["callsign"]
      });
    }
  });

// Self-serve change-password: must prove possession of the current password.
// Same min/max as register (8..200) — argon2 hashing of the new password makes
// the upper bound a DoS guard, the lower bound is a footgun guard.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200)
});

// Owner-only password reset for a self-registered user. We *generate* the
// new password server-side and return it once in the response; the operator
// then relays it out-of-band (Discord DM, email, whatever). This avoids
// trusting the operator's typed password to be strong, and gives them a
// guaranteed-unique value to hand the user.
const adminResetPasswordSchema = z.object({
  /** Optional: caller can supply their own value if they have a preferred channel; must clear our 8-char minimum. */
  newPassword: z.string().min(8).max(200).optional()
});

const inviteCreateSchema = z.object({
  /** Role minted on redemption. Omit (or null) to fall back to REGISTRATION_DEFAULT_ROLE. */
  role: z.enum(["guest", "pilot", "controller", "mod", "supermod"]).nullable().optional(),
  /** Total accounts the code can mint. 1..1000; default 1 keeps the common case safe. */
  maxUses: z.number().int().min(1).max(1000).optional(),
  /** ISO-8601 expiry. Omit for never-expires (until consumed or revoked). */
  expiresAt: z.string().datetime().nullable().optional(),
  /** Free-form label so OwnerDesk can group codes ("Forum #1234", "Discord LFG", etc.). */
  label: safeStr(120).optional()
});

const banSchema = z.object({
  userId: z.string().min(1).max(120),
  /** Omit for a permanent ban (supermod+ required); set for a temp ban (mod+). */
  durationSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  reason: safeStr(500).optional()
});

const muteSchema = z.object({
  userId: z.string().min(1).max(120),
  durationSeconds: z.number().int().positive().max(60 * 60 * 24 * 30),
  reason: safeStr(500).optional()
});

const banIpSchema = z.object({
  guestId: z.string().min(1).max(120),
  /** Omit for a permanent IP ban. */
  durationSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  reason: safeStr(500).optional()
});

// Kick is a soft, per-room correction: drop the user from one LiveKit room and
// block /livekit-token reissue for the same room for `durationSeconds`. The
// roomName regex pins it to the `tower-<sessionId>` namespace we actually mint
// (see /session/:sessionId/livekit-token) so a mod can't accidentally pin a
// cooldown against an arbitrary string. The optional `-booth` suffix lets the
// same endpoint target the spectator booth voice room (`tower-<sid>-booth`).
const KICK_DEFAULT_COOLDOWN_SEC = 5 * 60;
const KICK_MAX_COOLDOWN_SEC = 60 * 60;
const TOWER_ROOM_NAME_RE = /^tower-[A-Za-z0-9_-]{1,128}(?:-booth)?$/;
const kickSchema = z.object({
  userId: z.string().min(1).max(120),
  roomName: z.string().regex(TOWER_ROOM_NAME_RE, "roomName must look like tower-<sessionId> or tower-<sessionId>-booth"),
  durationSeconds: z
    .number()
    .int()
    .positive()
    .max(KICK_MAX_COOLDOWN_SEC)
    .optional(),
  reason: safeStr(500).optional()
});

const ROLE_VALUES = ["guest", "pilot", "controller", "mod", "supermod"] as const;
const setRoleSchema = z.object({
  userId: z.string().min(1),
  /** Owner role is excluded — only env `OWNER_USER_ID` mints the owner. */
  role: z.enum(ROLE_VALUES)
});

// Sanction-lifting schemas. All accept `{ userId }`; clear-cooldown also
// takes an optional `roomName` (omitted = clear every room cooldown for the
// identity at once). Schemas live next to the original ban/mute/kick schemas
// so the validation rules stay aligned (same userId max length etc.).
const unbanSchema = z.object({
  userId: z.string().min(1).max(120)
});
const unmuteSchema = z.object({
  userId: z.string().min(1).max(120)
});
const clearCooldownSchema = z.object({
  userId: z.string().min(1).max(120),
  roomName: z.string().regex(TOWER_ROOM_NAME_RE).optional()
});

const blockSchema = z.object({
  blockedUserId: z.string().min(1)
});

const messageBodySchema = z.object({
  // safeStr strips ASCII control bytes (ANSI escape sequences, BOM, U+0085 NEL,
  // ZWSP) before persistence so log tails, mod search, and the React renderer
  // all see the same canonical text.
  text: safeStr(4000).pipe(z.string().min(1))
});

// Body for POST /v1/session/:sessionId/livekit-token. `flavor` selects which
// LiveKit room the caller is asking for: `ops` (the existing pilot+tower room,
// default for back-compat), `booth` (the spectator commentary room), or
// `lobby_ops` (subscribe-only to the ops mix for users on the lobby who are
// not session members). The route handler enforces per-flavor authorization separately.
const livekitTokenSchema = z
  .object({
    flavor: z.enum(["ops", "booth", "lobby_ops"]).optional()
  })
  .optional();

// Body for POST /v1/session/:sessionId/booth/mute. `muted: true` puts the
// booth in kill-switch mode (spectator publish + chat blocked); `false` lifts
// it. Only callers holding `booth:moderate` reach this endpoint.
const boothMuteSchema = z.object({
  muted: z.boolean()
});

// POST /v1/session/:sessionId/waypoints — operator-placed shared map pin.
//
// `bodyName` defends against waypoints leaking between bodies (a Kerbin pin
// shouldn't render on the Mun map). `label` and `color` are optional UX hints;
// label is short (<= 60 chars) so the hover/legend doesn't overflow, color is
// a strict `#rrggbb` so the SVG fill is safe to inline without sanitisation.
const sharedWaypointBodySchema = z.object({
  bodyName: z.string().min(1).max(40),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  label: z.string().min(1).max(60).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/u, "color must be #rrggbb")
    .optional()
});

const dragonRadarStartSchema = z
  .object({
    bodyName: z.string().min(1).max(64).optional()
  })
  .optional();

const dragonRadarClaimSchema = z.object({
  ballId: z.string().min(1).max(32)
});

const dragonRadarCombatSchema = z.object({
  victimSessionId: z.string().min(1).max(120),
  kind: z.enum(["hit", "kill"])
});

const dragonRadarHailSchema = z.object({
  targetSessionId: z.string().min(1).max(120),
  frequencyMhz: z.string().regex(/^[0-9]{3}\.[0-9]{3}$/u, "Expected NNN.NNN"),
  note: safeStr(120).optional()
});

// kOS screen lines come in via the plugin's TowerKosScreenAutoCapture and never
// get rendered as chat — but we still strip control bytes via safeStr so a
// runaway script can't ANSI-paint the web terminal panel. Cap is generous
// (2000) so the server stays the source of truth even if the plugin's per-line
// hard truncate drifts in a future build.
const kosScreenLineSchema = z.object({
  line: safeStr(2000).pipe(z.string().min(1))
});

export const apiRouter = Router();

/**
 * Public landing-page metadata. No auth required — this is the *one* endpoint
 * an unauthenticated browser hits before deciding whether to render the
 * signup form, the invite-code field, the plugin install snippet, etc.
 *
 * Mounted before `loadIpBan` so a banned IP can still see the marketing copy
 * and contact links if they want to appeal.
 *
 * Response shape is intentionally narrow — no secrets, no env values that
 * aren't safe to surface (e.g. APP_JWT_SECRET, CLERK_*, MARIADB_*).
 */
apiRouter.get("/site/info", (_req, res) => {
  const ckanId = env.PLUGIN_CKAN_IDENTIFIER ?? null;
  res.json({
    ok: true,
    project: {
      displayName: env.PROJECT_DISPLAY_NAME,
      tagline: env.PROJECT_TAGLINE,
      repoUrl: env.PROJECT_REPO_URL ?? null,
      discordUrl: env.PROJECT_DISCORD_URL ?? null
    },
    plugin: {
      ckanIdentifier: ckanId,
      // Convenience: the canonical "drag this onto CKAN" URL for the catalog
      // entry, derived from the identifier so the frontend doesn't have to
      // hardcode the format.
      ckanCatalogUrl: ckanId ? `https://github.com/KSP-CKAN/CKAN-meta/tree/master/${ckanId}` : null,
      downloadUrl: env.PLUGIN_DOWNLOAD_URL ?? null,
      // KSP radio ◀ / ▶ quick-tune presets (mirrors TowerRadioGui QuickPresets).
      radioPresets: [...RADIO_QUICK_PRESETS]
    },
    registration: {
      mode: env.REGISTRATION_MODE,
      defaultRole: env.REGISTRATION_DEFAULT_ROLE,
      // Convenience flags so the React form doesn't have to switch on the
      // mode string in three places. `inviteRequired` means the form must
      // collect a code; `signupEnabled` means render the form at all.
      signupEnabled: env.REGISTRATION_MODE !== "closed",
      inviteRequired: env.REGISTRATION_MODE === "invite_only",
      inviteAccepted: env.REGISTRATION_MODE === "invite_only" || env.REGISTRATION_MODE === "open_or_invite",
      passwordMinLength: 8
    }
  });
});

// Every request below this point: drop banned IPs before they can do anything
// (including minting a fresh guest token).
apiRouter.use(loadIpBan);
// Cookie-authed mutations require a matching X-CSRF-Token; bearer-auth (KSP plugin,
// voice bridge, dev tooling) is unaffected. Mounted globally so every state-changing
// route inherits the check without per-route boilerplate.
apiRouter.use(csrfGuard);

/** Helper: 403 if the caller is currently muted. Used by chat/voice publish endpoints. */
async function assertNotMuted(req: Request, res: Response): Promise<boolean> {
  const access = await getUserAccess(req.auth!.userId);
  if (access.isMuted) {
    res.status(403).json({ error: "You are muted", reason: "muted" });
    return false;
  }
  return true;
}

function isSessionParticipantOrAdmin(
  userId: string,
  session: { pilotUserId: string; assignedTowerUserId?: string },
  isAdmin: boolean
): boolean {
  return isAdmin || session.pilotUserId === userId || session.assignedTowerUserId === userId;
}

/**
 * Read-side membership check. True if the caller is the pilot, the assigned
 * controller, an admin, OR a registered spectator. Used by `loadSessionIfAuthorized`
 * so spectators can fetch chat/telemetry/kOS/world-maps and get a subscribe-only
 * LiveKit token. Write paths (next-tower, block, rename, send chat, send kOS)
 * must still use `isSessionParticipantOrAdmin` so spectators stay read-only.
 */
function isSessionMemberOrAdmin(
  userId: string,
  session: { pilotUserId: string; assignedTowerUserId?: string; spectatorUserIds?: string[] },
  isAdmin: boolean
): boolean {
  if (isSessionParticipantOrAdmin(userId, session, isAdmin)) return true;
  return Array.isArray(session.spectatorUserIds) && session.spectatorUserIds.includes(userId);
}

async function loadSessionIfAuthorized(
  req: Request,
  res: Response,
  sessionId: string
): Promise<SessionRecord | null> {
  const session = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }

  const access = await getUserAccess(req.auth!.userId);
  if (access.isBanned) {
    res.status(403).json({ error: "Banned users cannot access sessions" });
    return null;
  }

  const isMod = roleAtLeast(access.role, "mod");
  const canView =
    (isServerOwnedRadioSessionId(session.id) && roleAtLeast(access.role, "pilot")) ||
    isSessionMemberOrAdmin(req.auth!.userId, session, isMod);

  if (!canView) {
    res.status(403).json({ error: "Not authorized for this session" });
    return null;
  }

  return session;
}

apiRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ksc-tower-backend",
    telemetryCadence: {
      defaultSeconds: env.TELEMETRY_DEFAULT_SECONDS,
      closeSeconds: env.TELEMETRY_CLOSE_SECONDS,
      closeApproachAglM: env.TELEMETRY_CLOSE_AGL_M
    },
    roleScopeV1: "tower"
  });
});

apiRouter.post(
  "/queue/join",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const access = await getUserAccess(req.auth!.userId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot join controller queue" });
      return;
    }

    const result = await joinTowerQueue(req.auth!.userId);
    await logAction(req.auth!.userId, "queue.join", { role: access.role, size: result.size });
    res.json({ ok: true, queueSize: result.size });
  }
);

apiRouter.post("/queue/leave", requireAuth, async (req, res) => {
  const result = await leaveTowerQueue(req.auth!.userId);
  await logAction(req.auth!.userId, "queue.leave", { size: result.size });
  res.json({ ok: true, queueSize: result.size });
});

/**
 * Read-only "is the caller in the controller queue right now, and how big is the
 * queue?" — used by the lobby's controller-mode UI so it can pick between Join /
 * Leave buttons without keeping local state. Anyone authed can read this; the
 * payload contains nothing user-private (your own queued state, plus the public
 * queue size that anyone can already infer by watching call assignments).
 */
apiRouter.get("/queue/status", requireAuth, async (req, res) => {
  const status = await getTowerQueueStatus(req.auth!.userId);
  res.json({ ok: true, inQueue: status.inQueue, queueSize: status.size });
});

apiRouter.post(
  "/auth/plugin/exchange-code",
  requireAuth,
  requireCapability("plugin:use"),
  pluginExchangeLimiter,
  async (req, res) => {
    const issued = await issueExchangeCode(req.auth!.userId);
    await logAction(req.auth!.userId, "auth.plugin.exchangeCode.issue");
    res.status(201).json({ ok: true, ...issued });
  }
);

apiRouter.post("/auth/plugin/exchange", authLimiter, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid exchange payload", details: parsed.error.flatten() });
    return;
  }

  const token = await exchangePluginToken(parsed.data.code);
  if (!token) {
    res.status(401).json({ error: "Invalid or expired exchange code" });
    return;
  }

  res.json({ ok: true, tokenType: "plugin_session", token });
});

apiRouter.post("/auth/login", authLimiter, async (req, res) => {
  const parsed = webLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload", details: parsed.error.flatten() });
    return;
  }

  const user = await authenticateWebUser(parsed.data.email, parsed.data.password);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Honor any existing self-set display-name override so signing out and
  // back in doesn't silently revert the user's chosen name to the email
  // local-part. Body `callsign` / `displayName` (same field) still wins when
  // the caller explicitly sends one.
  const requestedDisplayName =
    pilotLabelFromAuthBody(parsed.data) ?? getDisplayNameOverride(user.userId) ?? undefined;
  const displayName = resolveWebSessionDisplayName(user.email, requestedDisplayName);
  const token = issueWebSessionToken(user, displayName);
  const roles = await userRoleFlags(user.userId);

  // Set the session cookie so the SPA never has to touch the JWT directly.
  // We also still return the token in the response body for back-compat with
  // any existing client that stores it in localStorage; new code should rely
  // on the cookie + CSRF flow only.
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: env.APP_JWT_EXPIRES_IN_SECONDS * 1000
  });
  const csrfToken = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...csrfCookieOptions(),
    maxAge: env.APP_JWT_EXPIRES_IN_SECONDS * 1000
  });

  res.json({
    ok: true,
    token,
    csrfToken,
    user: {
      id: user.userId,
      email: user.email,
      displayName,
      callsign: displayName,
      role: roles.role,
      isOwner: roles.isOwner,
      isMod: roles.isMod,
      isAdmin: roles.isAdmin,
      isTower: roles.isTower,
      isGuest: roles.isGuest,
      capabilities: roles.capabilities
    }
  });
});

/**
 * Self-serve signup. Off by default (REGISTRATION_MODE=closed); the deployer
 * has to explicitly opt into `open`, `invite_only`, or `open_or_invite` before
 * this endpoint accepts anything.
 *
 * Flow:
 *   1. Validate body (email, 8+ char password, callsign/displayName, optional code).
 *   2. Check the mode gate.
 *   3. If a code was provided, consume it (atomic increment of `uses`).
 *      A consumed code's role wins over REGISTRATION_DEFAULT_ROLE.
 *   4. Hash the password (argon2id) and persist the row.
 *   5. Seed `localUserRoles` so `getUserAccess(newUserId)` resolves immediately
 *      without waiting for the next /auth/me round trip.
 *   6. Issue the same session cookie + body as /auth/login so the SPA can drop
 *      the user straight into /lobby on success.
 *
 * Mirrors /auth/login's cookie + CSRF mint at the bottom — kept inline (not
 * extracted) because the divergence in role/email resolution at the top makes
 * a shared helper more confusing than the duplication.
 */
apiRouter.post("/auth/register", authLimiter, async (req, res) => {
  const parsed = webRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration payload", details: parsed.error.flatten() });
    return;
  }
  const mode = env.REGISTRATION_MODE;
  if (mode === "closed") {
    res.status(403).json({ error: "Self-serve signup is disabled on this server.", reason: "registration_closed" });
    return;
  }

  const inviteProvided = !!parsed.data.inviteCode;
  if (mode === "invite_only" && !inviteProvided) {
    res.status(400).json({ error: "An invite code is required to register.", reason: "invite_required" });
    return;
  }

  // open_or_invite + no code → treat as plain "open". invite_only path always
  // requires a code (checked above). Plain "open" rejects unsolicited codes
  // entirely so a stale code can't unexpectedly mint an elevated role.
  //
  // Type widened to include "owner" because invite codes go through a unified
  // role union — but we never actually mint owners here: the create-invite
  // schema's `role` enum excludes "owner", so any "owner" string would have
  // been rejected at code-creation time. The widening is purely so the
  // assignment `resolvedRole = consume.role` typechecks.
  let resolvedRole: Role = env.REGISTRATION_DEFAULT_ROLE;
  if (inviteProvided) {
    if (mode === "open") {
      res.status(400).json({ error: "Invite codes are not enabled on this server.", reason: "invite_not_accepted" });
      return;
    }
    const consume = await consumeInviteCode(parsed.data.inviteCode!);
    if (!consume.ok) {
      res.status(400).json({
        error:
          consume.reason === "unknown"
            ? "Unknown invite code."
            : consume.reason === "expired"
            ? "This invite code has expired."
            : "This invite code has already been used the maximum number of times.",
        reason: `invite_${consume.reason}`
      });
      return;
    }
    if (consume.role) {
      resolvedRole = consume.role;
    }
  }

  const requested: RegisterUserRequest = {
    email: parsed.data.email,
    password: parsed.data.password,
    displayName: resolveWebSessionDisplayName(parsed.data.email, pilotLabelFromAuthBody(parsed.data)!),
    role: resolvedRole
  };
  const result = await registerUser(requested);
  if (!result.ok) {
    res.status(409).json({ error: "An account with that email already exists.", reason: result.reason });
    return;
  }

  ensureLocalRoleSeeded(result.user.userId, result.user.role);
  await logAction(result.user.userId, "auth.register", {
    email: result.user.email,
    role: result.user.role,
    invite: inviteProvided
  });

  // Drop them straight into a session — the SPA expects /auth/login-shaped
  // payloads (token + cookie + user object) and we want the post-signup
  // experience to be "you're already logged in", not "now please go log in".
  const token = issueWebSessionToken(
    { userId: result.user.userId, email: result.user.email, role: result.user.role },
    result.user.displayName
  );
  const roles = await userRoleFlags(result.user.userId);
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: env.APP_JWT_EXPIRES_IN_SECONDS * 1000
  });
  const csrfToken = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...csrfCookieOptions(),
    maxAge: env.APP_JWT_EXPIRES_IN_SECONDS * 1000
  });
  res.status(201).json({
    ok: true,
    token,
    csrfToken,
    user: {
      id: result.user.userId,
      email: result.user.email,
      displayName: result.user.displayName,
      callsign: result.user.displayName,
      role: roles.role,
      isOwner: roles.isOwner,
      isMod: roles.isMod,
      isAdmin: roles.isAdmin,
      isTower: roles.isTower,
      isGuest: roles.isGuest,
      capabilities: roles.capabilities
    }
  });
});

/**
 * Clears both the session cookie and the CSRF cookie. CSRF is enforced via
 * `csrfGuard` so cross-site logout-bombs cannot fire.
 */
apiRouter.post("/auth/logout", requireAuth, async (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, baseCookieOptions());
  res.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions());
  await logAction(req.auth!.userId, "auth.logout");
  res.json({ ok: true });
});

/**
 * Self-serve password change.
 *
 * Only works for accounts in the self-registered store (i.e. created via
 * /auth/register). Env-managed accounts from `WEB_LOGIN_USERS_JSON` are
 * intentionally NOT writable from here — their source of truth is the env
 * file on the server, and silently divergent state between env JSON and the
 * registered-users JSON would be a foot-cannon. The operator changes those
 * by editing the env. Same goes for guests (no password) and any non-web
 * principal.
 *
 * Rate-limited under `authLimiter` because a wrong-password slow-loop is a
 * brute-force vector and argon2 verify is itself expensive.
 */
apiRouter.post("/auth/change-password", requireAuth, authLimiter, async (req, res) => {
  const auth = req.auth!;
  // Plugin sessions are minted by /auth/plugin/exchange and have no password
  // of their own; guests have no credentials at all. Both are out of scope for
  // password rotation. The "clerk" tokenType is what /auth/login mints for
  // web users (the name is historical — see middleware/auth.ts).
  if (auth.tokenType === "plugin" || auth.tokenType === "guest") {
    res.status(403).json({ error: "This token type cannot change a password.", reason: "wrong_token_type" });
    return;
  }
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid change-password payload", details: parsed.error.flatten() });
    return;
  }
  if (!isRegisteredUserId(auth.userId)) {
    // Caller exists, just not in the writable store. Don't leak the existence
    // distinction beyond "you can't change it here" — the operator-managed
    // case is benign info, but it keeps the response uniform.
    res.status(403).json({
      error: "This account's password is managed by the server operator and cannot be changed from the app.",
      reason: "password_managed_by_operator"
    });
    return;
  }
  const result = await changeRegisteredUserPassword(
    auth.userId,
    parsed.data.currentPassword,
    parsed.data.newPassword
  );
  if (!result.ok) {
    if (result.reason === "wrong_password") {
      res.status(401).json({ error: "Current password is incorrect.", reason: "wrong_password" });
      return;
    }
    res.status(404).json({ error: "Account not found.", reason: result.reason });
    return;
  }
  await logAction(auth.userId, "auth.changePassword");
  res.json({ ok: true });
});

/**
 * Bootstrap (or rotate) the CSRF token cookie. The SPA calls this once on
 * startup so the double-submit pair exists before the first mutation; calling
 * it again rotates the token without requiring a logout.
 */
apiRouter.get("/auth/csrf", (_req, res) => {
  const csrfToken = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...csrfCookieOptions(),
    maxAge: env.APP_JWT_EXPIRES_IN_SECONDS * 1000
  });
  res.json({ ok: true, csrfToken });
});

/**
 * Guest sign-in: no credentials, IP captured server-side. Issues a short-lived JWT with
 * `token_type=guest`. Capabilities are limited to `chat:lobby`. The IP is stored on the
 * `guests` row so a mod can later ban that IP even after the guest disconnects.
 */
apiRouter.post("/auth/guest", authLimiter, async (req, res) => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  if (!ip) {
    res.status(400).json({ error: "Could not determine client IP" });
    return;
  }
  const { token, guest, expiresInSeconds } = await createGuestSession(ip);
  const roles = await userRoleFlags(guest.id);
  await logAction(guest.id, "auth.guest.create", { ip, displayName: guest.displayName });
  res.status(201).json({
    ok: true,
    token,
    expiresInSeconds,
    user: {
      id: guest.id,
      email: null,
      displayName: guest.displayName,
      role: roles.role,
      isOwner: false,
      isMod: false,
      isAdmin: false,
      isTower: false,
      isGuest: true,
      capabilities: roles.capabilities
    }
  });
});

apiRouter.get("/auth/me", requireAuth, async (req, res) => {
  const roles = await userRoleFlags(req.auth!.userId);
  // Prefer the user-set display-name override (Settings page) over whatever
  // was baked into the JWT at login time. The override is in-memory + (for
  // self-registered users) persisted to disk; see repository.setUserDisplayName.
  const override = getDisplayNameOverride(req.auth!.userId);
  const meName = override ?? req.auth?.displayName ?? null;
  res.json({
    ok: true,
    user: {
      id: req.auth!.userId,
      email: req.auth?.email ?? null,
      displayName: meName,
      callsign: meName,
      role: roles.role,
      isOwner: roles.isOwner,
      isMod: roles.isMod,
      isAdmin: roles.isAdmin,
      isTower: roles.isTower,
      isGuest: roles.isGuest,
      capabilities: roles.capabilities
    }
  });
});

/**
 * Self-serve display-name update. Lets a signed-in user rename themselves
 * from the Settings page without a mod having to touch anything.
 *
 * The new name is stored as an override (in-memory + persisted to the
 * registered-users JSON for self-registered accounts) and is preferred over
 * the JWT-issued name on subsequent /v1/auth/me reads, so the change shows
 * up immediately without needing to mint a fresh session token.
 *
 * Guests are intentionally allowed to rename themselves (their auto-assigned
 * "Guest_xxxx" handle is rarely what they want); the change is in-memory
 * only and lasts for the life of the guest session.
 */
const updateDisplayNameSchema = z
  .object({
    displayName: safeStr(120).optional(),
    callsign: safeStr(120).optional()
  })
  .superRefine((data, ctx) => {
    if (!pilotLabelFromAuthBody(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Callsign cannot be empty",
        path: ["callsign"]
      });
    }
  });

apiRouter.post("/me/display-name", requireAuth, async (req, res) => {
  const parsed = updateDisplayNameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid display-name payload", details: parsed.error.flatten() });
    return;
  }
  const userId = req.auth!.userId;
  const label = pilotLabelFromAuthBody(parsed.data)!;
  try {
    await setUserDisplayName(userId, label);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to update callsign" });
    return;
  }
  await logAction(userId, "me.display-name.update", {
    displayName: label
  });
  res.json({ ok: true, displayName: label, callsign: label });
});

/**
 * Self-serve moderation history. Returns the active bans/mutes plus the
 * recent past actions (ban/mute/kick/ban-ip) recorded against this user.
 * Implemented as a thin wrapper over `listUserModerationHistory` so the
 * exact same data the user sees is also what mods would see if they queried
 * the underlying records directly.
 */
apiRouter.get("/me/moderation-history", requireAuth, async (req, res) => {
  const history = await listUserModerationHistory(req.auth!.userId);
  res.json({ ok: true, ...history });
});

/**
 * Server-side source of truth for "is this user actually in a tower room?".
 *
 * The SPA used to derive this purely from a localStorage value, which made the
 * topbar happily display a stale "SESSION" pill and let the /tower route mount
 * with no real session — the desks then silently fell back to the `dev-shared`
 * bootstrap session, so voice "looked ready" while talking into an empty
 * LiveKit room. The web shell now polls this endpoint and uses the answer to:
 *   - render (or hide) the topbar room pill
 *   - show/hide the Tower + Wall nav links
 *   - gate the /tower route (redirect to /lobby when null)
 *   - sync localStorage so all the desks load the right session
 *
 * "Active" = the caller's best membership among non-`closed` sessions (excluding
 * `dev-shared`): **pilot** in any room beats **controller** in any room beats
 * **spectator** only. Within each tier we still pick the most-recently-updated
 * row so a pilot in two rooms (unusual) sees the liveliest one. Without this
 * ordering, spectating room B while flying as pilot in room A could surface B
 * first (newer `updatedAt`) and the web UI would wrongly show read-only
 * "spectator" for the whole shell.
 *
 * Returns `{ ok: true, activeRoom: null }` (HTTP 200) when the user isn't in a
 * room — the SPA polls this endpoint, so a 404 would just be a noisy log line.
 */
apiRouter.get("/me/active-room", requireAuth, async (req, res) => {
  const callerUserId = req.auth!.userId;
  const sessions = await listSessionsMerged();
  const isMember = (s: SessionRecord, userId: string): boolean =>
    s.pilotUserId === userId ||
    s.assignedTowerUserId === userId ||
    s.spectatorUserIds.includes(userId);

  /** Among rows in `cands`, keep the one with the greatest `updatedAt` (ISO strings). */
  const newestOf = (cands: SessionRecord[]): SessionRecord | undefined => {
    let best: SessionRecord | undefined;
    for (const s of cands) {
      if (!best || s.updatedAt.localeCompare(best.updatedAt) > 0) {
        best = s;
      }
    }
    return best;
  };

  const candidates = sessions.filter(
    (s) => s.id !== "dev-shared" && s.status !== "closed" && isMember(s, callerUserId)
  );
  const mine =
    newestOf(candidates.filter((s) => s.pilotUserId === callerUserId)) ??
    newestOf(candidates.filter((s) => s.assignedTowerUserId === callerUserId)) ??
    newestOf(candidates.filter((s) => s.spectatorUserIds.includes(callerUserId)));
  if (!mine) {
    res.json({ ok: true, activeRoom: null });
    return;
  }
  const session = withDerivedRoomLabels(mine);
  const myRole: "pilot" | "controller" | "spectator" =
    session.pilotUserId === callerUserId
      ? "pilot"
      : session.assignedTowerUserId === callerUserId
      ? "controller"
      : "spectator";
  res.json({
    ok: true,
    activeRoom: {
      roomId: session.id,
      roomName: session.name,
      name: session.name,
      frequencyMhz: session.frequencyMhz,
      status: session.status,
      myRole,
      towerPresent: !!session.assignedTowerUserId,
      spectatorCount: session.spectatorUserIds.length,
      boothMuted: getSessionBoothMuted(session),
      updatedAt: session.updatedAt
    }
  });
});

apiRouter.post("/session/call", requireAuth, requireCapability("plugin:use"), async (req, res) => {
  const parsed = callSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid call payload", details: parsed.error.flatten() });
    return;
  }

  const pilotUserId = req.auth!.userId;
  const access = await getUserAccess(pilotUserId);
  if (access.isBanned) {
    res.status(403).json({ error: "Banned users cannot create sessions" });
    return;
  }

  // Room-creation is a tower-seat operation: controller+ ranks (controller,
  // mod, supermod, owner) own the lobby and can spin up additional rooms as
  // needed. Pilot-rank web users are NOT allowed to create new rooms — they
  // belong in the default room (or whatever existing room a controller has
  // assigned them to), so the lobby doesn't sprawl into one-room-per-pilot.
  //
  // Plugin-token callers (the in-game KSP mod) are exempted: when a pilot
  // launches KSP with the plugin, `TowerSessionAutoCall` POSTs here to claim
  // a room so the controller queue has something to drain into. That's the
  // intended pilot-creates-room path; the web "Create room" button isn't.
  //
  // Previously this was inverted (controllers were BLOCKED, pilots allowed)
  // because controllers were getting stamped as the room's `pilotUserId`.
  // We accept that semantic now: a controller-created room has a
  // controller-shaped pilotUserId until a real pilot joins via the queue or
  // spectate flow; the lobby header just shows the room's `name` (callsign-
  // derived) so the cosmetic mismatch doesn't matter.
  const isPluginCaller = req.auth?.tokenType === "plugin";
  if (!isPluginCaller && !roleAtLeast(access.role, "controller")) {
    // Surface the role we actually computed for this caller so the next 403 in
    // the logs immediately tells us "they were pilot, not controller, that's
    // why" — without this you can't tell whether the user is logged in as the
    // wrong account, the JWT didn't verify (so they got the dev fallback id),
    // or seedConfiguredWebUserRoles never ran for their userId.
    logger.warn(
      {
        userId: pilotUserId,
        role: access.role,
        tokenType: req.auth?.tokenType,
        authSource: req.auth?.authSource,
        email: req.auth?.email
      },
      "session.call rejected: caller role is below controller"
    );
    res.status(403).json({
      error: "Only controllers and above can create new tower rooms from the lobby.",
      code: "pilot_cannot_create_room",
      hint: "Spectate an existing room, or wait for a controller to assign you to one.",
      diag: { role: access.role, tokenType: req.auth?.tokenType ?? null }
    });
    return;
  }

  // Back-compat: older plugin builds (and the floating radio panel) only sent
  // `name: "122.000"`. Treat a NNN.NNN-shaped name as the dialed frequency too.
  // If no frequency is supplied, the old "auto-call" behavior means "start on
  // tower" rather than "mint a new lobby room".
  const inferredFreqFromName =
    !parsed.data.frequencyMhz && parsed.data.name && /^[0-9]{3}\.[0-9]{3}$/.test(parsed.data.name.trim())
      ? parsed.data.name.trim()
      : undefined;
  const requestedFrequency =
    parsed.data.frequencyMhz ?? inferredFreqFromName ?? DEFAULT_RADIO_CALL_FREQUENCY_MHZ;

  const target = await getOrCreateServerRadioSessionByFrequency(requestedFrequency);
  if (!target) {
    res.status(404).json({
      error: "Frequency is not provisioned",
      code: "frequency_not_provisioned",
      frequencyMhz: requestedFrequency,
      hint: "Use one of the server-published radio presets; clients cannot create ad-hoc rooms."
    });
    return;
  }

  const session = withDerivedRoomLabels((await setSessionPilot(target.id, pilotUserId))!);
  // Atomic claim: previously this was nextTowerExcluding() + assignTower() which
  // could double-book the same controller for two concurrent /v1/call requests.
  const { assigned: nextTower } = await claimNextTowerForSession(
    session.id,
    new Set(session.blockedUserIds)
  );

  await logAction(pilotUserId, "session.call", {
    sessionId: session.id,
    kind: parsed.data.kind,
    craftName: parsed.data.craftName,
    name: session.name ?? null,
    frequencyMhz: session.frequencyMhz ?? null,
    requestedFrequencyMhz: requestedFrequency,
    assignedTowerUserId: nextTower ?? null
  });

  res.json({
    ok: true,
    sessionId: session.id,
    // `displayName` is the human label the lobby actually renders. `roomName`
    // is kept as a back-compat alias for older clients but resolves to the same
    // value. The LiveKit room name is fetched from /livekit-token.
    roomName: session.name,
    displayName: session.name,
    name: session.name,
    frequencyMhz: session.frequencyMhz,
    assignedTowerUserId: nextTower ?? null,
    status: nextTower ? "assigned" : "queued"
  });
});

// Plugin-side "join the room I just dialed" endpoint. Replaces the in-game
// radio's old "flip TowerModSettings.SessionId locally and never tell the
// backend" flow that left /v1/me/active-room returning null even though the
// plugin was actively publishing telemetry / hullcam to the room.
//
// Body: provide ONE of
//   { sessionId: string }    -> claim that specific room (e.g. picked from lobby)
//   { frequencyMhz: "NNN.NNN" } -> join the server-owned channel for that freq
//   { sessionId, frequencyMhz, name } -> belt-and-braces; sessionId wins
//
// Behavior:
//   - If a matching open session is found: setSessionPilot() takes over as pilot
//     (prior pilot is demoted to spectator so they keep voice). 410 if closed.
//   - Else: 404. Clients do not create ad-hoc voice rooms by typing a frequency.
//
// Capability gate matches /session/call (`plugin:use`) — this is the in-game
// pilot's "I am physically flying on this channel" claim, not a generic "let
// me yoink anyone's room" web button. Web users still spectate via
// /session/:id/spectate.
apiRouter.post(
  "/session/claim-pilot",
  requireAuth,
  requireCapability("plugin:use"),
  async (req, res) => {
    const parsed = claimPilotSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid claim payload", details: parsed.error.flatten() });
      return;
    }

    const callerUserId = req.auth!.userId;
    const access = await getUserAccess(callerUserId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot claim sessions" });
      return;
    }

    let target: SessionRecord | undefined;
    let mode: "by-id" | "by-freq" = "by-freq";

    if (parsed.data.sessionId) {
      target = await getSession(parsed.data.sessionId);
      if (!target) {
        // Stale id (e.g. plugin's auth.cfg still names a room the backend
        // dropped on restart). Fall through to create-by-frequency if the
        // caller also gave us a freq; otherwise 404 so the plugin knows to
        // mint a new room.
        if (!parsed.data.frequencyMhz) {
          res.status(404).json({ error: "Session not found", code: "session_not_found" });
          return;
        }
      } else {
        mode = "by-id";
      }
    }

    if (target && !isServerOwnedRadioSessionId(target.id)) {
      if (parsed.data.frequencyMhz) {
        target = undefined;
      } else {
        res.status(404).json({
          error: "Session is not a server radio channel",
          code: "session_not_radio_channel",
          hint: "Tune a provisioned frequency instead of reclaiming an old ad-hoc room."
        });
        return;
      }
    }

    if (!target && parsed.data.frequencyMhz) {
      target = await findOpenSessionByFrequency(parsed.data.frequencyMhz);
      if (target) mode = "by-freq";
    }

    if (target) {
      try {
        const updated = withDerivedRoomLabels((await setSessionPilot(target.id, callerUserId))!);

        await logAction(callerUserId, "session.claim-pilot", {
          sessionId: updated.id,
          mode,
          frequencyMhz: updated.frequencyMhz ?? null,
          requestedFrequencyMhz: parsed.data.frequencyMhz ?? null,
          priorPilotUserId: target.pilotUserId !== callerUserId ? target.pilotUserId : null
        });

        res.json({
          ok: true,
          sessionId: updated.id,
          roomName: updated.name,
          displayName: updated.name,
          name: updated.name,
          callsign: updated.callsign ?? null,
          frequencyMhz: updated.frequencyMhz,
          assignedTowerUserId: updated.assignedTowerUserId ?? null,
          status: updated.status,
          mode
        });
        return;
      } catch (err) {
        if (err instanceof SessionClosedError) {
          res.status(410).json({
            error: "Session is closed",
            code: "session_closed",
            sessionId: err.sessionId
          });
          return;
        }
        throw err;
      }
    }

    res.status(404).json({
      error: "Frequency is not provisioned",
      code: "frequency_not_provisioned",
      frequencyMhz: parsed.data.frequencyMhz ?? null,
      hint: "Use one of the server-published radio presets; clients cannot create ad-hoc rooms."
    });
  }
);

// Rename the lobby's "Tower room". Pilot of the session, the assigned controller, or
// any mod+ may rename. Pass body.name as a string to set, or `null` to clear (lobby UI
// then renders `tower-{sessionId}` as a fallback). The LiveKit room name is unaffected.
apiRouter.patch("/session/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const parsed = renameRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rename payload", details: parsed.error.flatten() });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const callerUserId = req.auth!.userId;
  const callerAccess = await getUserAccess(callerUserId);
  const isMod = roleAtLeast(callerAccess.role, "mod");
  const isPilot = session.pilotUserId === callerUserId;
  const isController = session.assignedTowerUserId === callerUserId;
  if (!isMod && !isPilot && !isController) {
    res.status(403).json({ error: "Only the pilot, the assigned controller, or a mod may rename this room" });
    return;
  }

  const updatedRaw = await setSessionName(sessionId, parsed.data.name);
  if (!updatedRaw) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  // Backfill so a cleared name (parsed.data.name === null) returns the auto-derived
  // callsign label, not null — the lobby card stays populated either way.
  const updated = withDerivedRoomLabels(updatedRaw);

  await logAction(callerUserId, "session.rename", {
    sessionId,
    name: updatedRaw.name ?? null
  });

  res.json({
    ok: true,
    sessionId,
    name: updated.name,
    displayName: updated.name,
    roomName: updated.name,
    frequencyMhz: updated.frequencyMhz
  });
});

// Join an existing tower room as a read-only spectator. Spectators can fetch
// chat / telemetry / kOS lines and get a subscribe-only LiveKit token, but
// every write path (chat send, kOS send, rename, next-tower, block, close)
// stays gated to the pilot / assigned controller / mod+. Guests are excluded
// because guest identities can't carry a meaningful presence in voice rooms
// and the spectator list is a moderation surface (a guest's `guest_xxx` id
// would be useless for follow-up action).
apiRouter.post("/session/:sessionId/spectate", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const callerUserId = req.auth!.userId;

  const access = await getUserAccess(callerUserId);
  if (access.isBanned) {
    res.status(403).json({ error: "Banned users cannot spectate sessions" });
    return;
  }
  if (access.role === "guest") {
    res.status(403).json({
      error: "Guests cannot spectate tower rooms",
      reason: "spectate_guest_denied"
    });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.status === "closed") {
    res.status(410).json({ error: "Session is closed", reason: "session_closed" });
    return;
  }
  if (session.blockedUserIds.includes(callerUserId)) {
    res.status(403).json({
      error: "You are blocked from this room",
      reason: "spectate_blocked"
    });
    return;
  }
  // No-op when already a participant: the lobby's "Open" button (pilot /
  // controller path) and the "Spectate" button funnel here so the SPA can
  // navigate to /tower without branching on role.
  if (session.pilotUserId === callerUserId || session.assignedTowerUserId === callerUserId) {
    res.json({ ok: true, sessionId, alreadyParticipant: true });
    return;
  }

  const updated = await addSessionSpectator(sessionId, callerUserId);
  if (!updated) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await logAction(callerUserId, "session.spectate", { sessionId });
  res.json({ ok: true, sessionId, spectatorCount: updated.spectatorUserIds.length });
});

// Leave a session. For spectators this just removes them from the spectator
// list (room keeps running for everyone else). For the pilot or assigned
// controller this is a no-op — they should call DELETE /v1/session/:id to
// close the room instead, since silently dropping the pilot would orphan the
// room with telemetry still arriving.
apiRouter.post("/session/:sessionId/leave", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const callerUserId = req.auth!.userId;

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const isPilot = session.pilotUserId === callerUserId;
  const isController = session.assignedTowerUserId === callerUserId;
  if (isPilot || isController) {
    res.status(409).json({
      error:
        isPilot
          ? "Pilots can't leave their own room — close it via DELETE /v1/session/:id instead."
          : "Assigned controllers can't leave — rotate the tower or close the room.",
      reason: "leave_pilot_or_controller_blocked"
    });
    return;
  }

  await removeSessionSpectator(sessionId, callerUserId);
  await logAction(callerUserId, "session.leave", { sessionId });
  res.json({ ok: true, sessionId });
});

// Close (soft-delete) a tower room. Allowed for the pilot, the assigned
// controller, or any mod+. The session row stays in the DB so chat / scorecard
// / telemetry survive for audit, but `/v1/lobby/rooms` filters it out and
// `/v1/me/active-room` stops returning it for everyone (pilot, controller,
// spectators), so all clients get punted back to the lobby on the next poll.
apiRouter.delete("/session/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const callerUserId = req.auth!.userId;

  // Refuse to close the dev-shared bootstrap session — it's an infrastructure
  // row that other code paths recreate on demand. Closing it would put the
  // SPA into a "no room" loop in dev open-auth mode.
  if (sessionId === "dev-shared") {
    res.status(400).json({ error: "Cannot close the dev-shared bootstrap session" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const access = await getUserAccess(callerUserId);
  const isMod = roleAtLeast(access.role, "mod");
  const isPilot = session.pilotUserId === callerUserId;
  const isController = session.assignedTowerUserId === callerUserId;
  if (!isMod && !isPilot && !isController) {
    res.status(403).json({
      error: "Only the pilot, assigned controller, or a mod may close this room"
    });
    return;
  }

  if (session.status === "closed") {
    res.json({ ok: true, sessionId, alreadyClosed: true });
    return;
  }

  const updated = await closeSession(sessionId);
  await logAction(callerUserId, "session.close", {
    sessionId,
    closedBy: isPilot ? "pilot" : isController ? "controller" : "mod"
  });
  res.json({ ok: true, sessionId, status: updated?.status ?? "closed" });
});

apiRouter.get("/session/:sessionId", requireAuth, async (req, res) => {
  incLiveMetric("live_http_requests");
  const sessionId = String(req.params.sessionId);
  const session = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const access = await getUserAccess(req.auth!.userId);
  if (access.isBanned) {
    res.status(403).json({ error: "Banned users cannot access sessions" });
    return;
  }

  const isMod = roleAtLeast(access.role, "mod");
  const canView =
    isSessionMemberOrAdmin(req.auth!.userId, session, isMod) || req.auth!.tokenType === "clerk";

  if (!canView) {
    res.status(403).json({ error: "Not authorized for this session" });
    return;
  }

  pruneStaleTakeoffRequest(session);
  pruneStaleStagingMoveRequest(session);
  const snapshot = await getSessionSnapshot(sessionId);
  if (!snapshot) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(snapshot);
});

apiRouter.get("/session/:sessionId/messages", requireAuth, async (req, res) => {
  incLiveMetric("live_http_requests");
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const since = typeof req.query.since === "string" && req.query.since.length > 0 ? req.query.since : undefined;
  if (since) {
    const messages = await listSessionMessages(sessionId, since);
    res.json({ ok: true, messages });
    return;
  }
  const snapshot = await getSessionMessagesSnapshot(sessionId);
  res.json(snapshot);
});

apiRouter.post(
  "/session/:sessionId/messages",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = messageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message payload", details: parsed.error.flatten() });
      return;
    }

    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) {
      return;
    }
    if (!(await assertNotMuted(req, res))) return;

    const message = await appendSessionMessage(sessionId, req.auth!.userId, parsed.data.text);
    await logAction(req.auth!.userId, "session.message", { sessionId, messageId: message.id });
    res.status(201).json({ ok: true, message });
  }
);

// ─── Booth (spectator commentary) chat + moderation ───────────────────────────
// The booth is a parallel chat thread + voice room scoped to a session, kept
// strictly separate from the ops channel: spectators talk to each other, the
// assigned tower controller bridges both sides, and the pilot is excluded.
// Storage reuses `session_messages` via the synthetic `booth:<sessionId>`
// thread id (mirrors how DMs avoid a schema migration). Pilots get a 403 even
// on GET so they can't passively eavesdrop on commentary.

/**
 * Membership predicate for the booth channel. Returns the caller's effective
 * booth role, or `null` if they shouldn't see the booth at all. `moderator`
 * collapses "assigned tower" + "mod+" because they share write-through
 * privileges (can post even when the kill-switch is on).
 */
type BoothRole = "moderator" | "spectator";
async function resolveBoothRole(
  req: Request,
  session: SessionRecord
): Promise<{ role: BoothRole; isMuted: boolean } | { role: null; reason: string; status: number }> {
  const userId = req.auth!.userId;
  const access = await getUserAccess(userId);
  if (access.isBanned) {
    return { role: null, reason: "Banned users cannot access the booth", status: 403 };
  }
  if (access.role === "guest") {
    return { role: null, reason: "Guests cannot access the booth", status: 403 };
  }
  const isMod = roleAtLeast(access.role, "mod");
  const isAssignedTower = session.assignedTowerUserId === userId;
  const isPilot = session.pilotUserId === userId;
  const isSpectator = session.spectatorUserIds.includes(userId);

  if (isPilot && !isMod) {
    return {
      role: null,
      reason: "Pilots aren't in the booth — that's the spectator commentary channel.",
      status: 403
    };
  }
  if (isAssignedTower || isMod) {
    return { role: "moderator", isMuted: access.isMuted };
  }
  if (isSpectator) {
    return { role: "spectator", isMuted: access.isMuted };
  }
  return {
    role: null,
    reason: "Spectate this room before opening the booth",
    status: 403
  };
}

apiRouter.get("/session/:sessionId/booth/messages", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) return;

  const role = await resolveBoothRole(req, session);
  if (role.role === null) {
    res.status(role.status).json({ error: role.reason, reason: "booth_denied" });
    return;
  }

  const since =
    typeof req.query.since === "string" && req.query.since.length > 0
      ? req.query.since
      : undefined;
  const messages = await listSessionMessages(boothThreadId(sessionId), since);
  res.json({
    ok: true,
    messages,
    boothMuted: getSessionBoothMuted(session),
    myBoothRole: role.role
  });
});

apiRouter.post(
  "/session/:sessionId/booth/messages",
  requireAuth,
  requireCapability("chat:booth"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = messageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message payload", details: parsed.error.flatten() });
      return;
    }

    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const role = await resolveBoothRole(req, session);
    if (role.role === null) {
      res.status(role.status).json({ error: role.reason, reason: "booth_denied" });
      return;
    }
    if (!(await assertNotMuted(req, res))) return;

    // Booth kill-switch: spectators are gagged; moderators (assigned tower /
    // mod+) bypass so they can announce "booth muted, focus on the call".
    if (getSessionBoothMuted(session) && role.role !== "moderator") {
      res.status(403).json({
        error: "Booth is muted by the tower",
        reason: "booth_muted"
      });
      return;
    }

    const message = await appendSessionMessage(
      boothThreadId(sessionId),
      req.auth!.userId,
      parsed.data.text
    );
    await logAction(req.auth!.userId, "session.booth.message", {
      sessionId,
      messageId: message.id,
      role: role.role
    });
    res.status(201).json({ ok: true, message });
  }
);

// Booth kill-switch toggle. Anyone holding `booth:moderate` (controller+ /
// mod+) can flip it. When `muted: true`, the in-memory `boothMuted` flag is
// set AND publish is revoked on the booth LiveKit room for everyone except
// the assigned controller and any current moderator. When `muted: false`,
// publish is restored. The flag also blocks future booth chat POSTs from
// non-moderators (see the booth/messages route above) and downgrades fresh
// /livekit-token booth requests to subscribe-only for non-moderators.
apiRouter.post(
  "/session/:sessionId/booth/mute",
  requireAuth,
  requireCapability("booth:moderate"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = boothMuteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid booth mute payload", details: parsed.error.flatten() });
      return;
    }

    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const role = await resolveBoothRole(req, session);
    if (role.role !== "moderator") {
      res.status(403).json({
        error: "Only the assigned tower controller or a mod can toggle the booth kill-switch",
        reason: "booth_mute_denied"
      });
      return;
    }

    const updated = await setSessionBoothMuted(sessionId, parsed.data.muted);
    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const exempt = new Set<string>();
    if (updated.assignedTowerUserId) exempt.add(updated.assignedTowerUserId);
    exempt.add(req.auth!.userId);

    const livekitUpdated = await setPublishForRoomParticipants(
      boothLiveKitRoomName(sessionId),
      !parsed.data.muted,
      exempt
    );

    await logAction(req.auth!.userId, "session.booth.mute", {
      sessionId,
      muted: parsed.data.muted,
      livekitUpdated
    });

    res.json({
      ok: true,
      sessionId,
      boothMuted: parsed.data.muted,
      livekitUpdated
    });
  }
);

// ─── Shared map waypoints ─────────────────────────────────────────────────────
// Operator-placed pins on the tower map, mirrored to every member of the room
// via the existing 1 s session-detail poll (the pins live on the SessionRecord
// and ride along in the GET /session/:id payload — no new fan-out is needed).
//
// Authn shape mirrors session messages: must be a session member (pilot,
// controller, spectator, or admin). We additionally require `chat:session`
// so muted/banned users can't pump the room full of pins. DELETE allows any
// session member to remove any pin (collaborative cleanup over ownership
// gymnastics — this is a 64-pin ephemeral list, not a moderation surface).

apiRouter.post(
  "/session/:sessionId/waypoints",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = sharedWaypointBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid waypoint payload", details: parsed.error.flatten() });
      return;
    }

    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;

    const result = await addSessionSharedWaypoint(sessionId, parsed.data, req.auth!.userId);
    if (!result) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await logAction(req.auth!.userId, "session.waypoint.add", {
      sessionId,
      waypointId: result.waypoint.id,
      bodyName: result.waypoint.bodyName
    });
    res.status(201).json({
      ok: true,
      waypoint: result.waypoint,
      sharedWaypoints: result.session.sharedWaypoints ?? []
    });
  }
);

apiRouter.delete(
  "/session/:sessionId/waypoints/:waypointId",
  requireAuth,
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const waypointId = String(req.params.waypointId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const updated = await removeSessionSharedWaypoint(sessionId, waypointId);
    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await logAction(req.auth!.userId, "session.waypoint.remove", { sessionId, waypointId });
    res.json({ ok: true, sharedWaypoints: updated.sharedWaypoints ?? [] });
  }
);

// ─── Dragon Radar room game ───────────────────────────────────────────────────
// Shared per-session Dragon Ball map used by the in-game radar minigame.
// State is ephemeral/in-memory by design (same lifecycle as shared waypoints).

apiRouter.get("/session/:sessionId/dragon-radar", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) return;

  const state = await getSessionDragonRadarGame(sessionId);
  res.json({
    ok: true,
    state: state ?? null,
    rules: getDragonRadarRules()
  });
});

apiRouter.post(
  "/session/:sessionId/dragon-radar/start",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = dragonRadarStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid dragon radar start payload", details: parsed.error.flatten() });
      return;
    }
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;

    const state = await startSessionDragonRadarGame(sessionId, {
      bodyName: parsed.data?.bodyName,
      startedBy: req.auth!.userId
    });
    if (!state) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    publishLiveSnapshotEvent({ topic: "session", sessionId });
    await logAction(req.auth!.userId, "dragon-radar.start", {
      sessionId,
      gameId: state.gameId,
      bodyName: state.bodyName
    });
    // Keep 200 for maximum client compatibility (some UnityWebRequest builds treat non-200 as errors).
    res.json({ ok: true, state, rules: DRAGON_RADAR_RULES });
  }
);

apiRouter.post(
  "/session/:sessionId/dragon-radar/claim",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = dragonRadarClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid dragon radar claim payload", details: parsed.error.flatten() });
      return;
    }
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;
    const access = await getUserAccess(req.auth!.userId);
    const isMod = roleAtLeast(access.role, "mod");
    const isController = session.assignedTowerUserId === req.auth!.userId;
    if (!isMod && session.pilotUserId !== req.auth!.userId && !isController) {
      res.status(403).json({
        error: "Only the pilot, the assigned controller, or a mod can claim Dragon Balls in this session"
      });
      return;
    }

    const outcome = await claimSessionDragonBall(sessionId, {
      ballId: parsed.data.ballId
    });
    if (!outcome) {
      res.status(404).json({ error: "Dragon radar game not found" });
      return;
    }
    if (outcome.claimed) {
      publishLiveSnapshotEvent({ topic: "session", sessionId });
      await logAction(req.auth!.userId, "dragon-radar.claim", {
        sessionId,
        ballId: parsed.data.ballId
      });
    }
    res.json({
      ok: true,
      claimed: outcome.claimed,
      reason: outcome.reason,
      state: outcome.state,
      rules: DRAGON_RADAR_RULES
    });
  }
);

apiRouter.post(
  "/session/:sessionId/dragon-radar/crew-revive-ack",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;
    const access = await getUserAccess(req.auth!.userId);
    const isMod = roleAtLeast(access.role, "mod");
    const isController = session.assignedTowerUserId === req.auth!.userId;
    if (!isMod && session.pilotUserId !== req.auth!.userId && !isController) {
      res.status(403).json({
        error: "Only the pilot, the assigned controller, or a mod can acknowledge Dragon Radar crew revive"
      });
      return;
    }

    const ack = await acknowledgeSessionDragonRadarCrewRevive(sessionId);
    if (!ack.ok) {
      res.status(400).json({ ok: false, reason: ack.reason ?? "ack_failed" });
      return;
    }
    publishLiveSnapshotEvent({ topic: "session", sessionId });
    await logAction(req.auth!.userId, "dragon-radar.crew-revive-ack", { sessionId });
    const state = await getSessionDragonRadarGame(sessionId);
    res.json({ ok: true, state, rules: DRAGON_RADAR_RULES });
  }
);

apiRouter.post(
  "/session/:sessionId/dragon-radar/combat",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = dragonRadarCombatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid dragon radar combat payload", details: parsed.error.flatten() });
      return;
    }
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;
    const access = await getUserAccess(req.auth!.userId);
    const isMod = roleAtLeast(access.role, "mod");
    const isController = session.assignedTowerUserId === req.auth!.userId;
    if (!isMod && session.pilotUserId !== req.auth!.userId && !isController) {
      res.status(403).json({
        error: "Only the pilot, the assigned controller, or a mod can post Dragon Radar combat in this session"
      });
      return;
    }

    if (sessionId === parsed.data.victimSessionId) {
      res.status(400).json({ error: "attacker and victim sessions must differ" });
      return;
    }
    const active = await getActiveAircraftSnapshot(req.auth!.userId);
    if (!active.aircraft.some((a) => a.sessionId === parsed.data.victimSessionId)) {
      res.status(400).json({
        error: "Victim session is not an active radar blip",
        reason: "victim_not_active"
      });
      return;
    }
    const outcome = await resolveSessionDragonRadarCombat(sessionId, {
      victimSessionId: parsed.data.victimSessionId,
      kind: parsed.data.kind
    });
    if (!outcome) {
      res.status(404).json({ error: "Dragon radar game not found" });
      return;
    }
    if (outcome.movedBalls > 0) {
      publishLiveSnapshotEvent({ topic: "session", sessionId });
      await logAction(req.auth!.userId, "dragon-radar.combat", {
        sessionId,
        attackerSessionId: sessionId,
        victimSessionId: parsed.data.victimSessionId,
        kind: parsed.data.kind,
        movedBalls: outcome.movedBalls
      });
    }
    res.json({
      ok: true,
      movedBalls: outcome.movedBalls,
      state: outcome.state,
      rules: DRAGON_RADAR_RULES
    });
  }
);

apiRouter.post(
  "/session/:sessionId/dragon-radar/hail",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = dragonRadarHailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid dragon radar hail payload", details: parsed.error.flatten() });
      return;
    }
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await assertNotMuted(req, res))) return;

    const active = await getActiveAircraftSnapshot(req.auth!.userId);
    const targetSessionId = parsed.data.targetSessionId.trim();
    if (
      targetSessionId !== sessionId &&
      !active.aircraft.some((a) => a.sessionId === targetSessionId)
    ) {
      res.status(400).json({
        error: "Target session is not an active radar blip",
        reason: "target_not_active"
      });
      return;
    }

    let targetSession: SessionRecord | undefined;
    if (targetSessionId !== sessionId) {
      targetSession = await getSession(targetSessionId);
      if (!targetSession) {
        res.status(404).json({ error: "Target session not found" });
        return;
      }
    }

    const note = parsed.data.note?.trim();
    const payload =
      `[RADAR HAIL] target=${targetSessionId} freq=${parsed.data.frequencyMhz} MHz` +
      (note ? ` note=${note}` : "");

    const roomMessage = await appendSessionMessage(sessionId, req.auth!.userId, payload);
    let targetMessageId: string | undefined;
    if (targetSessionId !== sessionId && targetSession) {
      const mirrored = await appendSessionMessage(targetSessionId, req.auth!.userId, payload);
      targetMessageId = mirrored.id;
    }
    await logAction(req.auth!.userId, "dragon-radar.hail", {
      sessionId,
      targetSessionId,
      frequencyMhz: parsed.data.frequencyMhz,
      mirroredToTarget: Boolean(targetMessageId)
    });
    res.json({
      ok: true,
      message: roomMessage,
      mirroredToTarget: Boolean(targetMessageId),
      targetMessageId
    });
  }
);

// ─── kOS screen mirror ────────────────────────────────────────────────────────
// One-way pipe from in-game kOS terminals to the web Tower desk. The plugin's
// TowerKosScreenAutoCapture reflectively walks every kOSProcessor and POSTs
// each terminal line as it changes; the web KosScreenPanel polls GET with
// `since=<iso>` to render new lines incrementally.
// Auth shape mirrors session messages: must be a session participant (or admin),
// and must hold the same chat:session capability so muted/banned users can't
// flood the panel either.

apiRouter.get("/session/:sessionId/kos-screen", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const since = typeof req.query.since === "string" && req.query.since.length > 0 ? req.query.since : undefined;
  const lines = await listKosScreenLines(sessionId, since);
  res.json({ ok: true, lines });
});

apiRouter.post(
  "/session/:sessionId/kos-screen",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsed = kosScreenLineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid kOS screen payload", details: parsed.error.flatten() });
      return;
    }

    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) {
      return;
    }
    if (!(await assertNotMuted(req, res))) return;

    const line = await appendKosScreenLine(sessionId, req.auth!.userId, parsed.data.line);
    res.status(201).json({ ok: true, line });
  }
);

apiRouter.get("/lobby/messages", requireAuth, async (req, res) => {
  const since = typeof req.query.since === "string" && req.query.since.length > 0 ? req.query.since : undefined;
  const messages = await listLobbyMessages(since);
  res.json({ ok: true, messages });
});

apiRouter.post("/lobby/messages", requireAuth, requireCapability("chat:lobby"), writeLimiter, async (req, res) => {
  const parsed = messageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid message payload", details: parsed.error.flatten() });
    return;
  }
  if (!(await assertNotMuted(req, res))) return;
  const message = await appendLobbyMessage(req.auth!.userId, parsed.data.text);
  await logAction(req.auth!.userId, "lobby.message", { messageId: message.id });
  res.status(201).json({ ok: true, message });
});

// ─── Direct messages ──────────────────────────────────────────────────────────
// 1:1 ACARS between two authenticated users. Storage reuses session_messages
// with a synthetic `dm:<lo>|<hi>` thread id (see dmThreadId() in repository).
// All four routes require chat:dm (pilot+ baseline; guests are intentionally
// excluded — see the capability table). No `requireCapability("chat:dm")` is
// needed on `/v1/dm/peers` and `/v1/dm/threads` because they are read-only,
// but we still keep them behind it so a banned/guest user doesn't see UI hints
// that DMs even exist.

/**
 * Cheap pre-check for any DM operation: rejects empty / self / guest peers.
 * Both GET and POST routes start with this; POST additionally verifies the
 * peer exists in the caller's known-peer set so you can't spam-create thread
 * rows for fictional userIds.
 */
function isSyntacticallyValidDmPeer(callerUserId: string, peerUserId: string): boolean {
  if (!peerUserId || peerUserId === callerUserId) return false;
  // Guests are ephemeral; their token expires and the inbox can never be read again.
  if (peerUserId.startsWith("guest_")) return false;
  return true;
}

/**
 * Returns true when `peerUserId` shows up in the caller's allowed-peer set
 * (configured web users plus anyone they already have an open DM thread with).
 * Used to gate `POST /v1/dm/:peer/messages` so a caller can't open new threads
 * with arbitrary fictional userIds, while still allowing replies to peers who
 * have been removed from `WEB_LOGIN_USERS_JSON` after the thread already exists.
 */
async function isAddressableDmPeer(callerUserId: string, peerUserId: string): Promise<boolean> {
  const peers = await listDirectMessagePeers(callerUserId);
  for (const p of peers) {
    if (p.userId === peerUserId) return true;
  }
  return false;
}

apiRouter.get("/dm/peers", requireAuth, requireCapability("chat:dm"), async (req, res) => {
  const peers = await listDirectMessagePeers(req.auth!.userId);
  res.json({ ok: true, peers });
});

apiRouter.get("/dm/threads", requireAuth, requireCapability("chat:dm"), async (req, res) => {
  const threads = await listDirectMessageThreads(req.auth!.userId);
  res.json({ ok: true, threads });
});

apiRouter.get(
  "/dm/:peerUserId/messages",
  requireAuth,
  requireCapability("chat:dm"),
  async (req, res) => {
    const peerUserId = String(req.params.peerUserId);
    // GET is intentionally permissive on peer identity: if a thread already
    // exists with someone who has since been removed from the configured
    // users list, the caller still needs to be able to read (and archive) the
    // history. Empty arrays are fine for unknown peers.
    if (!isSyntacticallyValidDmPeer(req.auth!.userId, peerUserId)) {
      res.status(400).json({ error: "Invalid DM peer" });
      return;
    }

    const access = await getUserAccess(req.auth!.userId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot read direct messages" });
      return;
    }

    const since =
      typeof req.query.since === "string" && req.query.since.length > 0 ? req.query.since : undefined;
    const messages = await listDirectMessages(req.auth!.userId, peerUserId, since);
    res.json({ ok: true, peerUserId, messages });
  }
);

apiRouter.post(
  "/dm/:peerUserId/messages",
  requireAuth,
  requireCapability("chat:dm"),
  writeLimiter,
  async (req, res) => {
    const peerUserId = String(req.params.peerUserId);
    if (!isSyntacticallyValidDmPeer(req.auth!.userId, peerUserId)) {
      res.status(400).json({ error: "Invalid DM peer" });
      return;
    }

    // Only allow POST to peers the caller could pick from `/v1/dm/peers`. This
    // stops a hostile (or just confused) client from creating thread rows for
    // arbitrary fabricated userIds. Replies to a peer who used to exist still
    // work because `listDirectMessagePeers` includes existing thread peers.
    if (!(await isAddressableDmPeer(req.auth!.userId, peerUserId))) {
      res.status(404).json({
        error: "Unknown DM peer",
        reason: "not_in_directory",
        peerUserId
      });
      return;
    }

    const parsed = messageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message payload", details: parsed.error.flatten() });
      return;
    }

    const access = await getUserAccess(req.auth!.userId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot send direct messages" });
      return;
    }
    if (!(await assertNotMuted(req, res))) return;

    const message = await appendDirectMessage(req.auth!.userId, peerUserId, parsed.data.text);
    await logAction(req.auth!.userId, "dm.message", {
      peerUserId,
      messageId: message.id
    });
    res.status(201).json({ ok: true, peerUserId, message });
  }
);

apiRouter.get("/lobby/rooms", requireAuth, async (req, res) => {
  const sessions = await listSessionsMerged();
  const chatSummary = await listChatRoomSummariesAdmin();
  const chatCounts = new Map(chatSummary.map((item) => [item.sessionId, item]));

  const callerUserId = req.auth!.userId;
  const callerAccess = await getUserAccess(callerUserId);
  const isMod = roleAtLeast(callerAccess.role, "mod");

  // Non-mods used to receive every session's pilot id and assigned controller id,
  // letting any authenticated user (including guests) enumerate the global roster.
  // Identifying fields are now restricted to mods+; everyone else still gets the
  // counts/status they need to render the lobby, plus their own session for context.
  // `dev-shared` is an internal bootstrap session used as a fallback target by
  // the desk/lobby when no real session id is present. It must never appear in
  // the lobby room list — otherwise it shows up as a permanent duplicate of
  // the user's real tower room.
  const rooms = sessions
    .filter((session) => session.status !== "closed" && session.id !== "dev-shared")
    .map((rawSession) => {
      // withDerivedRoomLabels backfills a callsign-based default name and a stable
      // notional VHF frequency for any row that was minted before the name /
      // frequency_mhz columns existed. After this, `session.name` and
      // `session.frequencyMhz` are guaranteed strings — the lobby NEVER sees a
      // `tower-<UUID>` heading. See repository.ts and docs/GLOSSARY.md "Room name".
      const session = withDerivedRoomLabels(rawSession);
      const summary = chatCounts.get(session.id);
      const callerMembership: "pilot" | "controller" | "spectator" | null =
        session.pilotUserId === callerUserId
          ? "pilot"
          : session.assignedTowerUserId === callerUserId
            ? "controller"
            : session.spectatorUserIds.includes(callerUserId)
              ? "spectator"
              : null;
      const isOwnSession = callerMembership === "pilot" || callerMembership === "controller";
      const isSpectating = callerMembership === "spectator";
      const exposeIdentities = isMod || isOwnSession;
      return {
        roomId: session.id,
        // Human label rendered as the lobby card heading. Always populated.
        roomName: session.name,
        // Same value as `roomName`; kept as an explicit field so clients that want
        // to distinguish "user-chosen vs auto-generated" can compare against
        // `rawSession.name` if a future endpoint exposes that.
        name: session.name,
        // Cosmetic VHF frequency for "real radio" feel ("118.300"). Always populated.
        frequencyMhz: session.frequencyMhz,
        sessionId: session.id,
        status: session.status,
        pilotUserId: exposeIdentities ? session.pilotUserId : null,
        assignedTowerUserId: exposeIdentities ? session.assignedTowerUserId ?? null : null,
        towerPresent: !!session.assignedTowerUserId,
        listenersAllowed: true,
        // Spectator count is public (no identifying info); the lobby card uses
        // it to render "3 listening" so pilots can see if anyone's tuned in.
        spectatorCount: session.spectatorUserIds.length,
        callsign: session.callsign ?? null,
        // Lets the lobby render a "Leave" affordance instead of "Spectate" on
        // rooms the caller is already listening to, so the action stays honest.
        viewerIsSpectating: isSpectating,
        /**
         * How the authenticated caller relates to this session, from the same
         * `req.auth.userId` the backend uses everywhere (including dev open-auth
         * identity-bridge to the in-game plugin). The SPA must not infer this by
         * comparing `room.pilotUserId` to `user.id` from the login payload — those
         * strings diverge whenever the bridge stamps the plugin userId on API
         * calls but the React shell still holds `DEV_USER_ID`, which made every
         * card show only "Spectate" + disabled Rename even for the pilot's own room.
         */
        callerMembership,
        messageCount: summary?.messageCount ?? 0,
        lastMessageAt: summary?.lastMessageAt ?? null,
        updatedAt: session.updatedAt
      };
    });

  res.json({ ok: true, rooms });
});

apiRouter.post("/session/:sessionId/next-tower", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const existing = await getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const access = await getUserAccess(req.auth!.userId);
  const isMod = roleAtLeast(access.role, "mod");
  if (!isSessionParticipantOrAdmin(req.auth!.userId, existing, isMod)) {
    res.status(403).json({ error: "Not authorized to rotate tower for this session" });
    return;
  }

  const session = await rotateNextTower(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await logAction(req.auth!.userId, "session.nextTower", {
    sessionId: session.id,
    assignedTowerUserId: session.assignedTowerUserId ?? null
  });

  res.json({ ok: true, session });
});

/**
 * Vacate the tower seat for a session. Two distinct callers funnel here:
 *
 *   1. Self-release ("Stand down") — the currently assigned controller wants
 *      to give up the seat without closing the room. They get punted back to
 *      the lobby on the next /me/active-room poll.
 *   2. Mod kick — a mod / supermod / owner removes a controller who is
 *      unresponsive (closed their browser without a clean release, AFK with a
 *      pilot waiting on them, etc.). Without this path the seat would stay
 *      stuck on the original controller forever, since /v1/session/:id/leave
 *      explicitly refuses to release pilots or assigned controllers.
 *
 * `assignNext` (default true) tries to immediately claim a replacement from
 * the controller queue using `claimNextTowerForSession`, with the
 * just-released user excluded. Set false to leave the seat empty (e.g. a mod
 * who is going to take the seat themselves via the queue right after).
 */
const releaseTowerSchema = z.object({
  assignNext: z.boolean().optional()
});

apiRouter.post("/session/:sessionId/release-tower", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const parsed = releaseTowerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid release-tower payload", details: parsed.error.flatten() });
    return;
  }

  const existing = await getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (existing.status === "closed") {
    res.status(410).json({ error: "Session is closed", reason: "session_closed" });
    return;
  }

  const callerUserId = req.auth!.userId;
  const access = await getUserAccess(callerUserId);
  const isMod = roleAtLeast(access.role, "mod");
  const isAssignedController = existing.assignedTowerUserId === callerUserId;

  if (!isMod && !isAssignedController) {
    res.status(403).json({
      error: "Only the assigned controller or a mod may release this tower",
      reason: "release_not_authorized"
    });
    return;
  }

  if (!existing.assignedTowerUserId) {
    // Already vacant — return success so a double-click / pagehide-beacon race
    // doesn't surface a confusing 4xx in the controller's UI.
    res.json({
      ok: true,
      sessionId,
      releasedUserId: null,
      replacement: null,
      alreadyVacant: true
    });
    return;
  }

  const assignNext = parsed.data.assignNext ?? true;
  const result = await clearAssignedTower(sessionId, { tryReplaceFromQueue: assignNext });

  await logAction(callerUserId, "session.releaseTower", {
    sessionId,
    releasedUserId: result.releasedUserId ?? null,
    by: isAssignedController ? "self" : "mod",
    replacement: result.replacement ?? null,
    assignNext
  });

  res.json({
    ok: true,
    sessionId,
    releasedUserId: result.releasedUserId ?? null,
    replacement: result.replacement ?? null,
    session: result.session ?? null
  });
});

/**
 * Self-serve tower claim. Counterpart to <c>/release-tower</c>: lets the caller take
 * the controller seat of a session WITHOUT going through the queue. Two intended uses:
 *
 *   1. Solo / dev play — the same account is the pilot of a room (created by their KSP
 *      plugin via <c>/v1/session/call</c>) and also wants to be the tower for it. Useful
 *      for testing, single-player roleplay, or "I'll just self-tower so I can fly with
 *      ATIS / METAR overlays" workflows.
 *
 *   2. Lobby controller who launched KSP — the plugin already created their pilot
 *      session; flipping the same account into the controller seat too means they don't
 *      have to wait for someone else to claim from the queue before they can start
 *      transmitting / receiving. The voice mix still works (LiveKit doesn't echo your
 *      own track back to you), and ACARS behaves normally.
 *
 * Permissions:
 *   - Caller must have the <c>controller:assume</c> capability (same gate as
 *     <c>POST /v1/queue/join</c>) so a pure pilot account can't bypass the queue
 *     to take seats they otherwise couldn't.
 *   - Caller must be the pilot of this session (<c>pilotUserId === callerUserId</c>),
 *     OR be a spectator currently registered on this room (controller clicked
 *     "Spectate" first), OR be a mod+ (so a mod can hot-fix a stuck-empty seat
 *     without going through the queue dance). A controller-rank user who is neither
 *     pilot nor in-room spectator must still go through <c>/queue/join</c> +
 *     <c>claimNextTowerForSession</c> like anyone else, so the fair-queue ordering
 *     for *other people's* rooms is preserved.
 *   - The seat must be currently vacant. We deliberately do NOT support displacing the
 *     existing controller — that's what <c>/release-tower</c> + <c>/queue/join</c> is
 *     for, and silent displacement would be a griefing vector.
 *   - The session must be open (not closed).
 */
apiRouter.post(
  "/session/:sessionId/claim-tower",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const existing = await getSession(sessionId);
    if (!existing) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (existing.status === "closed") {
      res.status(410).json({ error: "Session is closed", reason: "session_closed" });
      return;
    }

    const callerUserId = req.auth!.userId;
    const access = await getUserAccess(callerUserId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot claim tower seats" });
      return;
    }
    const isMod = roleAtLeast(access.role, "mod");
    const isPilotOfThisRoom = existing.pilotUserId === callerUserId;
    const isSpectatorOfThisRoom = existing.spectatorUserIds.includes(callerUserId);
    if (!isMod && !isPilotOfThisRoom && !isSpectatorOfThisRoom) {
      res.status(403).json({
        error:
          "Only the pilot of this room, an in-room spectator, or a mod may claim the tower seat directly. " +
          "Use POST /v1/queue/join to receive an assignment from the queue.",
        reason: "claim_not_authorized"
      });
      return;
    }

    if (existing.assignedTowerUserId) {
      // Idempotent: if the caller is already the assigned controller, return success
      // so a double-click / re-launch race doesn't surface a confusing 409.
      if (existing.assignedTowerUserId === callerUserId) {
        res.json({
          ok: true,
          sessionId,
          assignedTowerUserId: callerUserId,
          alreadyAssigned: true,
          session: existing
        });
        return;
      }
      res.status(409).json({
        error: "Tower seat is already taken",
        reason: "seat_taken",
        assignedTowerUserId: existing.assignedTowerUserId
      });
      return;
    }

    let session = await assignTower(sessionId, callerUserId);
    if (isSpectatorOfThisRoom) {
      session = await removeSessionSpectator(sessionId, callerUserId);
    }
    await logAction(callerUserId, "session.claimTower", {
      sessionId,
      asPilot: isPilotOfThisRoom,
      asSpectator: isSpectatorOfThisRoom && !isPilotOfThisRoom,
      asMod: isMod && !isPilotOfThisRoom && !isSpectatorOfThisRoom
    });

    res.json({
      ok: true,
      sessionId,
      assignedTowerUserId: callerUserId,
      session: session ?? null
    });
  }
);

apiRouter.post("/session/:sessionId/block", requireAuth, async (req, res) => {
  const parsed = blockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid block payload", details: parsed.error.flatten() });
    return;
  }

  const sessionId = String(req.params.sessionId);
  const existing = await getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const access = await getUserAccess(req.auth!.userId);
  const isMod = roleAtLeast(access.role, "mod");
  if (!isSessionParticipantOrAdmin(req.auth!.userId, existing, isMod)) {
    res.status(403).json({ error: "Not authorized to block users for this session" });
    return;
  }

  const session = await blockUserForSession(sessionId, parsed.data.blockedUserId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await logAction(req.auth!.userId, "session.blockUser", {
    sessionId: session.id,
    blockedUserId: parsed.data.blockedUserId
  });

  res.json({ ok: true, session });
});

apiRouter.post("/telemetry/:sessionId", requireAuth, telemetryLimiter, async (req, res) => {
  incLiveMetric("live_http_requests");
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid telemetry payload", details: parsed.error.flatten() });
    return;
  }

  const sessionId = String(req.params.sessionId);
  // KSC-TOWER-* ids are a hullcam-only namespace (see hullcamStore.isKscTowerSessionId).
  // They have no `sessions` row, so any telemetry posted under them would be dropped
  // anyway — but we 400 explicitly so a misconfigured plugin in tower-stream mode
  // surfaces as a loud error instead of a silent telemetry blackout.
  if (isKscTowerSessionId(sessionId)) {
    res.status(400).json({
      error: "KSC tower view-stream sessions cannot publish telemetry",
      hint: "Disable 'Stream as Tower' before flying as a pilot, or only push hullcam frames"
    });
    return;
  }
  const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const devSharedOpenTelemetry =
    sessionId === "dev-shared" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    env.DEV_OPEN_AUTH;

  if (!devSharedOpenTelemetry && req.auth!.userId !== existing.pilotUserId) {
    res.status(403).json({ error: "Only pilot can submit telemetry for this session" });
    return;
  }

  const prevSample = existing.telemetry;
  const session = await setTelemetry(sessionId, parsed.data);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Run scoring detectors (pure, side-effect free) over the prev → curr sample pair.
  // The detector module owns its sliding window per session so penalties like `broke_g`
  // can be debounced even across multiple telemetry posts.
  try {
    const sessionEpochSec = Math.floor(Date.now() / 1000);
    const events = detectFromTelemetry(prevSample, parsed.data, sessionId, sessionEpochSec);
    for (const ev of events) {
      const dedupeBucket = `${sessionId}:${ev.kind}:${ev.bucketSec}`;
      // eslint-disable-next-line no-await-in-loop
      await awardEvent({
        sessionId,
        targetUserId: existing.pilotUserId,
        kind: ev.kind,
        points: ev.points,
        label: ev.label,
        source: "auto",
        dedupeBucket
      });
      // eslint-disable-next-line no-await-in-loop
      await appendSessionMessage(sessionId, "system", `[${ev.kind.toUpperCase()}] ${ev.label}`);
    }
  } catch (error) {
    // Scoring is best-effort; never fail telemetry just because the score path blew up.
    // This route is on the hot path (1-5s cadence per pilot) so we swallow and log.
    // eslint-disable-next-line no-console
    console.warn("scoring failed for session %s: %s", sessionId, (error as Error).message);
  }

  // Telemetry-driven checklist auto-tick. Best-effort — never break the telemetry hot path.
  try {
    const phases = session.checklistPhases ?? DEFAULT_CHECKLIST_PHASES;
    const flipped = await evaluateAndApplyAutoRules(sessionId, phases, parsed.data);
    if (flipped.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await appendSessionMessage(
        sessionId,
        "system",
        `[CHECKLIST] auto-ticked ${flipped.length} pilot item${flipped.length === 1 ? "" : "s"}`
      );
      const refreshed = await getSession(sessionId);
      const sideJustComplete =
        refreshed != null &&
        checklistSideComplete(phases, refreshed.checklistState, "pilot");
      if (sideJustComplete) {
        await appendSessionMessage(sessionId, "system", `[CHECKLIST] pilot side complete ✓`);
      }
      emitChecklistEvent({
        kind: "auto",
        sessionId,
        at: new Date().toISOString(),
        itemIds: flipped
      });
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        itemIds: flipped
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("autoRule eval failed for session %s: %s", sessionId, (error as Error).message);
  }

  let approachSequence: { index: number; of: number; gapKmBehindLeader?: number } | null = null;
  try {
    const hook = await runTowerTelemetryHooks(sessionId, prevSample, parsed.data, session);
    approachSequence = hook.approachSequence;
  } catch {
    // best-effort only
  }

  res.json(buildTelemetryReplyPayload(session, { approachSequence }));
});

/**
 * Plugin-pushed "going dark" status — the publisher calls this when it deliberately
 * stops streaming so the controller's UI can render *why* (beacon switched off,
 * pilot exited Flight scene, on-rails warp, vessel destroyed) instead of letting
 * the last telemetry sample masquerade as live.
 *
 * Re-uses the same `telemetryLimiter` bucket as `/telemetry` because in the worst
 * case (rapid beacon toggling) the two endpoints share a hot path. Cleared
 * automatically on the next successful `/telemetry` POST — see `setTelemetry`.
 */
apiRouter.post("/telemetry-status/:sessionId", requireAuth, telemetryLimiter, async (req, res) => {
  incLiveMetric("live_http_requests");
  const parsed = telemetryStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid telemetry-status payload", details: parsed.error.flatten() });
    return;
  }

  const sessionId = String(req.params.sessionId);
  if (isKscTowerSessionId(sessionId)) {
    res.status(400).json({
      error: "KSC tower view-stream sessions cannot publish telemetry status"
    });
    return;
  }
  const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const devSharedOpenTelemetry =
    sessionId === "dev-shared" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    env.DEV_OPEN_AUTH;

  if (!devSharedOpenTelemetry && req.auth!.userId !== existing.pilotUserId) {
    res.status(403).json({ error: "Only pilot can publish telemetry status for this session" });
    return;
  }

  const event: TelemetryStatusEvent = {
    state: parsed.data.state,
    at: new Date().toISOString(),
    message: parsed.data.message
  };
  const session = await setTelemetryStatus(sessionId, event);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({ ok: true, sessionId: session.id, telemetryStatus: event });
});

// World-inventory: posted once per game session by the KSP plugin (TowerWorldInventory.cs).
// Carries the player's actual home body, navaids and launch sites so the web map can re-plot
// itself on top of any planet pack (RSS, JNSQ, GPP, …) instead of always assuming stock Kerbin.
//
// Heavily-modded installs (RSS+RO, JNSQ+OPM, etc.) push the navaid/launch-site list past the
// global 1 MB JSON limit — observed payloads are ~1.2 MB. Mount a per-route parser at 4 MB so
// the global cap stays tight for the chat/auth surface but the inventory POST still goes through.
const WORLD_INVENTORY_JSON_PARSER = express.json({ limit: "4mb" });
apiRouter.post(
  "/world-inventory/:sessionId",
  WORLD_INVENTORY_JSON_PARSER,
  requireAuth,
  heavyPublishLimiter,
  async (req, res) => {
  const parsed = worldInventorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid world-inventory payload", details: parsed.error.flatten() });
    return;
  }

  const sessionId = String(req.params.sessionId);
  const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Only the pilot (or dev-shared in dev) can publish a world inventory — controllers reading
  // the map must not be able to overwrite the active pilot's planet pack data with their own.
  const devSharedOpen =
    sessionId === "dev-shared" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    env.DEV_OPEN_AUTH;
  if (!devSharedOpen && req.auth!.userId !== existing.pilotUserId) {
    res.status(403).json({ error: "Only pilot can publish world inventory for this session" });
    return;
  }

  const rec = setWorldInventory(sessionId, req.auth!.userId, parsed.data);
  res.json({
    ok: true,
    sessionId,
    receivedAt: rec.receivedAt,
    homeBody: rec.home.name,
    counts: { mods: rec.mods.length, navaids: rec.navaids.length, launchSites: rec.launchSites.length }
  });
});

apiRouter.get("/world-inventory/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const rec = getWorldInventory(sessionId);
  if (!rec) {
    res.status(404).json({ error: "No world inventory published for this session yet" });
    return;
  }

  // Don't leak which user POSTed the inventory to controllers; just return the inventory itself
  // plus the wallclock timestamp so the UI can show "scanned 14s ago".
  res.json({
    ok: true,
    sessionId,
    receivedAt: rec.receivedAt,
    schemaVersion: rec.schemaVersion,
    scannedAt: rec.scannedAt,
    home: rec.home,
    mods: rec.mods,
    navaids: rec.navaids,
    launchSites: rec.launchSites,
    worldId: rec.worldId
  });
});

// World-maps: posted by `TowerBasemapBaker.cs` once per game session with the home body's PQS
// terrain baked into a pure-vector SVG plate. The web map (TowerDesk.tsx) fetches the manifest,
// picks a layer (Alt / Biome / Slope), and swaps the bundled schematic basemap for the SVG —
// graticule and navaid overlays stay in place because the SVG ships the same `viewBox` and
// `preserveAspectRatio` the overlay uses.
//
// The base64-encoded PNG payloads inside the JSON envelope can be quite large at the full
// scaledSpace native resolution: stock Kerbin (2048x1024) is ~1-2 MB total, RSS Earth at the
// 8192x4096 cap can hit ~20 MB across both layers (alt + biome). We mount a per-route json
// parser so the global limit (1 MB) stays tight for everything else and only this one ingress
// endpoint pays the price. Sized so a fully schema-legal payload (4 layers * BYTES_BASE64_MAX
// ≈ 64 MB body) plus envelope JSON fits without 413; raise both in lockstep if the per-layer
// schema cap goes up. RECORD_BYTES_MAX in worldMaps.ts gates the *decoded* total per record.
const WORLD_MAPS_JSON_PARSER = express.json({ limit: "72mb" });

apiRouter.post(
  "/world-maps/:sessionId",
  WORLD_MAPS_JSON_PARSER,
  requireAuth,
  heavyPublishLimiter,
  async (req, res) => {
    const parsed = worldMapsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid world-maps payload", details: parsed.error.flatten() });
      return;
    }

    const sessionId = String(req.params.sessionId);
    const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
    if (!existing) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Same publisher gate as world-inventory: only the pilot (or anyone in dev-shared / dev mode)
    // may overwrite the bake. Controllers reading the map can't shadow the pilot's terrain.
    const devSharedOpen =
      sessionId === "dev-shared" &&
      (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
      env.DEV_OPEN_AUTH;
    if (!devSharedOpen && req.auth!.userId !== existing.pilotUserId) {
      res.status(403).json({ error: "Only pilot can publish world maps for this session" });
      return;
    }

    let rec;
    try {
      rec = setWorldMaps(sessionId, req.auth!.userId, parsed.data);
    } catch (err) {
      if (err instanceof UnsafeSvgError) {
        res.status(400).json({ error: err.message, reason: "unsafe_svg" });
        return;
      }
      if (err instanceof WorldMapsTooLargeError) {
        res.status(413).json({ error: err.message, reason: "payload_too_large" });
        return;
      }
      throw err;
    }
    res.json({
      ok: true,
      sessionId,
      receivedAt: rec.receivedAt,
      body: rec.body.name,
      layers: rec.layers.map((l) => ({
        id: l.id,
        label: l.label,
        bytes: l.bytes.length,
        viewBoxW: l.viewBoxW,
        viewBoxH: l.viewBoxH
      }))
    });
  }
);

// Manifest: lists which layers are baked for this session. SVG bytes live behind the per-layer
// GET below so the manifest stays a few hundred bytes (web polls it once a minute alongside
// world-inventory).
apiRouter.get("/world-maps/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const rec = getWorldMaps(sessionId);
  if (!rec) {
    res.status(404).json({ error: "No world maps published for this session yet" });
    return;
  }

  res.json({
    ok: true,
    sessionId,
    receivedAt: rec.receivedAt,
    schemaVersion: rec.schemaVersion,
    scannedAt: rec.scannedAt,
    body: rec.body,
    layers: rec.layers.map((l) => ({
      id: l.id,
      label: l.label,
      contentType: l.contentType,
      viewBoxW: l.viewBoxW,
      viewBoxH: l.viewBoxH,
      minH: l.minH,
      maxH: l.maxH,
      hypsometryKey: l.hypsometryKey,
      bytes: l.bytes.length,
      etag: l.etag,
      // Same-origin path the web side uses as `<basemap.uri>`. Include the etag suffix in the
      // querystring so the browser cache key bumps automatically when the pilot re-bakes.
      url: `/v1/world-maps/${encodeURIComponent(sessionId)}/layer/${l.id}?v=${encodeURIComponent(l.etag)}`
    })),
    features: rec.features
  });
});

// Raw SVG for a single layer. Honors If-None-Match (the manifest carries the etag) so the browser
// only re-downloads when the pilot publishes a new bake. We deliberately do NOT enable gzip here:
// the SVG is small enough to send raw, and helmet's defaults add Content-Encoding-aware vary
// headers that occasionally trip up Vite's dev proxy.
apiRouter.get("/world-maps/:sessionId/layer/:layerId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const layerId = String(req.params.layerId);
  if (layerId !== "alt" && layerId !== "biome" && layerId !== "slope") {
    res.status(400).json({ error: "Unknown layer id (expected alt|biome|slope)" });
    return;
  }

  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const found = getWorldMapsLayer(sessionId, layerId);
  if (!found) {
    res.status(404).json({ error: `No '${layerId}' layer baked for this session` });
    return;
  }

  res.setHeader("Content-Type", found.layer.contentType);
  res.setHeader("ETag", found.layer.etag);
  // Long max-age with `must-revalidate` is safe because the URL carries the etag suffix; any
  // re-bake with new bytes lands at a different cache key.
  res.setHeader("Cache-Control", "private, max-age=600, must-revalidate");

  if (req.headers["if-none-match"] === found.layer.etag) {
    res.status(304).end();
    return;
  }

  res.status(200).send(found.layer.bytes);
});

// HullCam relay: pilot's KSP plugin pulls JPEG snapshots from JustReadTheInstructions
// (http://localhost:8080) and POSTs them here at ~1 fps. Frames are kept in memory only
// (see services/hullcamStore.ts); tower clients poll the GET endpoints below.
//
// We mount express.raw per-route because the global JSON parser in index.ts (limit "1mb")
// won't pass an image/jpeg body through, and we don't want to enlarge the JSON limit just
// for this.
//
// 192 KB is the hard ceiling. JRTI's typical 1280x720 quality-75 frame is 30-80 KB and
// even quality-95 sits well under 192 KB; anything larger is either a misconfigured JRTI
// render res or a malicious client bypassing the plugin's own clamp. The plugin defaults
// `HullCamMaxBytes` to 192000 too, so an honest pilot is never anywhere near this.
//
// Worst-case ingress at the per-user 5 fps limit: 5 * 192 KB = 960 KB/s/user, which is
// the budget we're prepared to spend on a single attacker's stream before the rate
// limiter kicks in. Do NOT raise this without lowering hullcamLimiter to match.
const HULLCAM_MAX_BODY_BYTES = 192 * 1024;
apiRouter.post("/craft-thumbnail/:sessionId", requireAuth, heavyPublishLimiter,
  express.raw({ type: "image/png", limit: CRAFT_THUMBNAIL_MAX_BYTES }), async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
    if (!session || session.status === "closed") { res.status(404).json({ error: "Session not found" }); return; }
    if (session.pilotUserId !== req.auth!.userId) { res.status(403).json({ error: "Only the pilot can publish a craft thumbnail" }); return; }
    let craftName: string;
    try { craftName = decodeURIComponent((req.header("x-craft-name") ?? "").slice(0, 768)); }
    catch { res.status(400).json({ error: "Invalid craft name" }); return; }
    if (!craftName || craftName.length > 128 || /[\u0000-\u001f]/u.test(craftName)) { res.status(400).json({ error: "Invalid craft name" }); return; }
    if (session.telemetry?.craftName !== craftName) { res.status(409).json({ error: "Thumbnail does not match the active craft" }); return; }
    if (!Buffer.isBuffer(req.body) || !req.body.length) { res.status(400).json({ error: "Body must be a PNG thumbnail" }); return; }
    let png: Buffer;
    try { png = await normalizeCraftThumbnail(req.body); }
    catch { res.status(400).json({ error: "Invalid PNG thumbnail" }); return; }
    // A vessel switch during image decoding must not replace the new craft's image.
    const current = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
    if (!current || current.status === "closed" || current.telemetry?.craftName !== craftName) { res.status(409).json({ error: "Active craft changed" }); return; }
    putCraftThumbnail(sessionId, craftName, png);
    res.json({ ok: true });
  });

apiRouter.get("/craft-thumbnail/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const access = await getUserAccess(req.auth!.userId);
  if (access.isBanned) { res.status(403).json({ error: "Banned users cannot view craft thumbnails" }); return; }
  // Controllers can inspect any radar track; other viewers need session membership.
  const session = roleAtLeast(access.role, "controller")
    ? await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId)
    : await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) { if (!res.headersSent) res.status(404).json({ error: "Session not found" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  const name = typeof req.query.craftName === "string" ? req.query.craftName : "";
  const thumbnail = session.status !== "closed" && name === session.telemetry?.craftName ? getCraftThumbnail(sessionId, name) : null;
  if (!thumbnail) { res.status(404).json({ error: "No thumbnail for this craft" }); return; }
  res.type("image/png").send(thumbnail.png);
});

const HULLCAM_RAW_PARSER = express.raw({
  type: "image/jpeg",
  limit: HULLCAM_MAX_BODY_BYTES
});
// JRTI keys cameras by Unity's `GetInstanceID()`, which is a signed 32-bit int and is
// very often negative (e.g. -255963743). The earlier "non-negative, <=1M" schema rejected
// every real frame from JRTI; here we accept the full Int32 range and nothing wider, so
// we still defend against absurd values without dropping legitimate uploads.
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const cameraIdSchema = z
  .string()
  .regex(/^-?\d+$/u, "cameraId must be an integer")
  .transform((s) => Number(s))
  .refine(
    (n) => Number.isSafeInteger(n) && n >= INT32_MIN && n <= INT32_MAX,
    "cameraId out of Int32 range"
  );

apiRouter.post(
  "/hullcam/:sessionId/:cameraId",
  requireAuth,
  hullcamLimiter,
  HULLCAM_RAW_PARSER,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const parsedCamId = cameraIdSchema.safeParse(req.params.cameraId);
    if (!parsedCamId.success) {
      res.status(400).json({ error: "Invalid cameraId" });
      return;
    }

    // KSC-TOWER-* is the dedicated "view from the tower window" hullcam namespace.
    // It deliberately has no `sessions` row: the publisher is a signed-in pilot
    // streaming their KSP camera from the runway/KSC, and we don't want that
    // to enter the lobby/queue/scoring graph. Authorization here is just
    // "you're signed in" — anyone can publish, anyone authed can view, and the
    // session id is opaque so collisions just overwrite each others' frames
    // (the plugin namespaces by the user's id suffix to avoid that).
    if (isKscTowerSessionId(sessionId)) {
      // fall through to the JPEG-validation + putHullCamFrame block below
    } else {
      const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
      if (!existing) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Same authorization shape as /telemetry: only the pilot (or dev-shared in dev) may push
      // frames for a session. Otherwise a controller could spoof a video feed.
      const devSharedOpen =
        sessionId === "dev-shared" &&
        (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
        env.DEV_OPEN_AUTH;
      if (!devSharedOpen && req.auth!.userId !== existing.pilotUserId) {
        res.status(403).json({ error: "Only pilot can publish HullCam frames for this session" });
        return;
      }
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res
        .status(400)
        .json({ error: "Body must be a non-empty image/jpeg payload (use Content-Type: image/jpeg)" });
      return;
    }

    // JPEG SOI marker check; rejects anything that obviously isn't a JPEG so we never end up
    // serving HTML/garbage to the tower's <img>.
    if (req.body[0] !== 0xff || req.body[1] !== 0xd8) {
      res.status(400).json({ error: "Body is not a JPEG (missing SOI marker)" });
      return;
    }

    // Cap the raw header BEFORE decoding so a 6 KB url-encoded string can't waste
    // CPU in decodeURIComponent only to be sliced to 64 chars after.
    const rawName = (req.header("x-camera-name") ?? "").slice(0, 256);
    let decodedName = "";
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      decodedName = rawName;
    }
    // Strip C0/C1 control chars (incl. NUL, BEL, ESC) and the bidi-override characters
    // (U+202A..U+202E, U+2066..U+2069). These never appear in legitimate JRTI camera
    // names ("ServiceBay-Cam-2", etc.) and otherwise corrupt log lines, the radio
    // panel display, and any future text-based renderer that isn't React-escaped.
    const sanitizedName = decodedName
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, "")
      .trim()
      .slice(0, 64);
    const name = sanitizedName || `Cam ${parsedCamId.data}`;

    putHullCamFrame(sessionId, parsedCamId.data, name, req.body);
    publishLiveSnapshotEvent({ topic: "hullcam-meta", sessionId });
    res.json({ ok: true, nextFrameMs: 1000 });
  }
);

apiRouter.get("/hullcam/:sessionId", requireAuth, async (req, res) => {
  incLiveMetric("live_http_requests");
  const sessionId = String(req.params.sessionId);
  // KSC tower view-stream sessions: any signed-in user can list cameras (it's
  // a public-ish "look out the tower window" feed). Skip the session-membership
  // gate since there is no session row to be a member of.
  if (!isKscTowerSessionId(sessionId)) {
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) {
      return;
    }
  }

  const cameras = listHullCamCameras(sessionId).map((c) => ({
    id: c.id,
    name: c.name,
    updatedAtMs: c.updatedAtMs,
    snapshotUrl: `/v1/hullcam/${encodeURIComponent(sessionId)}/${c.id}/snapshot.jpg`
  }));

  res.json({
    ok: true,
    sessionId,
    cameras,
    serverNowMs: Date.now(),
    staleMs: HULLCAM_STALE_MS
  });
});

apiRouter.get("/hullcam/:sessionId/:cameraId/snapshot.jpg", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const parsedCamId = cameraIdSchema.safeParse(req.params.cameraId);
  if (!parsedCamId.success) {
    res.status(400).json({ error: "Invalid cameraId" });
    return;
  }

  if (!isKscTowerSessionId(sessionId)) {
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) {
      return;
    }
  }

  const frame = getHullCamFrame(sessionId, parsedCamId.data);
  if (!frame) {
    // 503 (rather than 404) so the tower UI can distinguish "camera went LOS" from
    // "no such session" and back off briefly without flapping its placeholder.
    res.status(503).json({ error: "No fresh frame", reason: "los" });
    return;
  }

  // Content-negotiate WebP vs. mozjpeg. Both variants are downscaled to <=960px
  // wide and cached on the frame, so the first viewer pays the encode cost (a
  // few ms) and every subsequent poll for this same frame hits a memcpy. See
  // services/hullcamCompress.ts for the lazy-cache + dedupe details.
  //
  // We must Vary on Accept so a CDN/proxy never serves a webp byte stream to a
  // jpeg-only client (or vice versa) just because the URL matches.
  const acceptsWebp = (req.header("accept") ?? "").toLowerCase().includes("image/webp");
  let body: Buffer;
  let contentType: string;
  try {
    if (acceptsWebp) {
      const out = await getWebp(frame);
      body = out.buf;
      contentType = out.isWebp ? "image/webp" : "image/jpeg";
    } else {
      body = await getOptimizedJpeg(frame);
      contentType = "image/jpeg";
    }
  } catch {
    // Belt-and-braces: getOptimizedJpeg/getWebp are designed to fail open and
    // never throw, but if something exotic does we still owe the viewer a
    // frame, so fall back to the raw JRTI bytes.
    body = frame.jpeg;
    contentType = "image/jpeg";
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Accept");
  res.setHeader("X-Frame-Age-Ms", String(Date.now() - frame.updatedAtMs));
  res.setHeader("X-Frame-Bytes-Orig", String(frame.jpeg.length));
  res.status(200).send(body);
});

// ---------------------------------------------------------------------------
// Tower-room awareness endpoints (Ghost Fleet & Tower View)
// ---------------------------------------------------------------------------
//
// Both endpoints are read-only and exist purely to feed the in-game "tower
// room" presence layer:
//   * `active-aircraft`   — what other pilots are currently flying, so the
//                           plugin's TowerGhostFleet can spawn render-only
//                           proxy meshes inside the player's KSC scene.
//   * `view-streams`      — which KSC-TOWER-* hullcam relays are currently
//                           live, so a controller's web UI can render the
//                           "look out the tower window" tile.
//
// Neither endpoint mutates any session, queue, or score — so any signed-in
// user (pilot, controller, guest) is allowed in.

apiRouter.get("/tower/active-aircraft", requireAuth, async (req, res) => {
  incLiveMetric("live_http_requests");
  const snapshot = await getActiveAircraftSnapshot(req.auth!.userId);
  res.json(snapshot);
});

apiRouter.get("/live/metrics", requireAuth, requireRole("mod"), async (_req, res) => {
  res.json({ ok: true, metrics: getLiveMetricsSnapshot() });
});

apiRouter.get("/tower/view-streams", requireAuth, async (_req, res) => {
  incLiveMetric("live_http_requests");
  res.json(getTowerViewStreamsSnapshot());
});

apiRouter.get("/atis/current", requireAuth, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const role = await effectiveRole(req);
  const anchor = roleAtLeast(role, "controller") ? "tower_fixed" : "pilot_geo_ip";
  const cur = await getAtisCurrentForClient(typeof ip === "string" ? ip : String(ip), { anchor });
  res.json({ ok: true, ...cur });
});

/**
 * Mono WAV of the current ATIS broadcast (same renderer as POST /atis/preview-audio).
 * KSP plugin: tune ATIS MHz → GET with bearer → loop AudioClip locally (no voice-bridge mux).
 */
apiRouter.get("/atis/current.wav", requireAuth, writeLimiter, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const role = await effectiveRole(req);
  const anchor = roleAtLeast(role, "controller") ? "tower_fixed" : "pilot_geo_ip";
  const cur = await getAtisCurrentForClient(typeof ip === "string" ? ip : String(ip), { anchor });
  const buf = await renderAtisPreviewAudio(cur.text);
  if (!buf) {
    res.status(501).json({
      error:
        "ATIS WAV is not available on this host. Install espeak-ng on PATH, or run the backend on Windows with PowerShell SAPI."
    });
    return;
  }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Disposition", 'inline; filename="atis-current.wav"');
  res.send(buf);
});

apiRouter.post("/atis/preview-audio", requireAuth, writeLimiter, async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string") {
    res.status(400).json({ error: "text must be a string" });
    return;
  }
  const buf = await renderAtisPreviewAudio(text);
  if (!buf) {
    res.status(501).json({
      error:
        "ATIS preview WAV is not available on this host. Install espeak-ng on PATH, or run the backend on Windows with PowerShell SAPI."
    });
    return;
  }
  res.setHeader("Content-Type", "audio/wav");
  res.send(buf);
});

apiRouter.post("/atis/admin/force-advance", requireAuth, requireRole("mod"), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const cur = await forceAdvanceAtis(typeof ip === "string" ? ip : String(ip));
  res.json({ ok: true, ...cur });
});

apiRouter.post("/atis/admin/regen", requireAuth, requireRole("mod"), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const cur = await regenAtisCache(typeof ip === "string" ? ip : String(ip));
  res.json({ ok: true, ...cur });
});

/**
 * Per-vessel parts manifest, uploaded by the KSP plugin once per
 * vessel-load (and again on stage / dock / undock). Drives the web Tower
 * Desk's VesselSchematicPanel — the controller sees an SVG schematic of
 * the inbound craft so they can spot stage configuration, missing landing
 * gear, or asymmetric loadouts at a glance. See
 * `VESSELVIEW_INTEGRATION_PLAN.md` for the design.
 *
 * Storage is in-memory only (`vesselManifestStore`); the publisher
 * regenerates within seconds of a backend restart, so persistence buys us
 * nothing.
 *
 * Auth/limits mirror `/telemetry`:
 *   - pilot-only: only the session's pilot may publish their own manifest
 *     (a controller posting one would be impersonation).
 *   - `KSC-TOWER-*` sessionIds are explicitly rejected; those are a
 *     hullcam-only namespace with no parts tree.
 *   - rate-limited via `heavyPublishLimiter` (6/min/user) — the publisher
 *     debounces to one POST per ~2 s of vessel changes, so this is well
 *     above any honest cadence and below anything that could DDoS the
 *     in-memory store.
 *
 * Body shape: see `vesselManifestSchema` below. Total payload capped at
 * 64 KB by the per-route schema (parts list bounded + per-field bounds);
 * the global JSON parser is at 1 MB, so the schema is the real limit.
 */
const PART_NAME_MAX = 96;
const PART_TAG_MAX = 24;
const PARTS_MAX = 600;
const TAGS_PER_PART_MAX = 6;
const FINITE_FLOAT_24 = z.number().finite();
const FINITE_INT_16 = z.number().int().min(-32_768).max(32_767);
const finiteVec3 = z.tuple([FINITE_FLOAT_24, FINITE_FLOAT_24, FINITE_FLOAT_24]);
const finiteQuat = z.tuple([
  FINITE_FLOAT_24,
  FINITE_FLOAT_24,
  FINITE_FLOAT_24,
  FINITE_FLOAT_24
]);

const vesselManifestPartSchema = z.object({
  /** Index in the manifest's `parts` array; matches the `parent` references. */
  i: FINITE_INT_16.nonnegative(),
  /** Canonical KSP part name (`part.partInfo.name`). */
  n: z.string().min(1).max(PART_NAME_MAX),
  /** Position relative to the root part, vessel local frame, metres. */
  p: finiteVec3,
  /** Rotation relative to root, [x, y, z, w] quaternion. */
  r: finiteQuat,
  /** Axis-aligned bounds extents in vessel local frame, metres (always >= 0). */
  b: z.tuple([
    FINITE_FLOAT_24.nonnegative(),
    FINITE_FLOAT_24.nonnegative(),
    FINITE_FLOAT_24.nonnegative()
  ]),
  /** Dry mass in tonnes. */
  m: FINITE_FLOAT_24.nonnegative(),
  /** Index of the parent part; -1 for the root. */
  parent: FINITE_INT_16.min(-1),
  /** `part.inverseStage`. KSP allows -1 ("not staged"). */
  stage: FINITE_INT_16.min(-1),
  /**
   * Cheap classifier tags (cockpit, fueltank, engine, gear, wing, fairing,
   * decoupler, control-surface, science, ...) the web renderer maps to
   * stroke/fill colours. Bounded to keep payload tight.
   */
  tags: z.array(z.string().min(1).max(PART_TAG_MAX)).max(TAGS_PER_PART_MAX).default([])
});

const vesselManifestSchema = z.object({
  /**
   * KSP `Vessel.persistentId` of the craft this manifest describes. Echoed
   * in the response so the web client can detect "this is a different ship
   * than what I had cached" without comparing the whole parts tree.
   */
  persistentId: z.string().min(1).max(64),
  craftName: z.string().min(1).max(120),
  /**
   * Same `craftMapIcon` the telemetry stream emits ("plane", "rover",
   * "rocket"). Used as a fallback when the web renderer's tag classifier
   * doesn't have an opinion.
   */
  craftMapIcon: z.string().min(1).max(32).default("plane"),
  /** Index of the root part in `parts`. Always 0 in practice; bounded for safety. */
  rootPartIndex: FINITE_INT_16.nonnegative().default(0),
  /**
   * `true` when the publisher had to drop low-signal parts (struts, fuel
   * lines, etc.) to fit under its byte cap. Surfaced in the web tile so
   * controllers know the schematic isn't complete.
   */
  truncated: z.boolean().default(false),
  parts: z.array(vesselManifestPartSchema).min(1).max(PARTS_MAX)
});

apiRouter.post(
  "/vessel-manifest/:sessionId",
  requireAuth,
  heavyPublishLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);

    // Hullcam-only namespace; no parts tree to publish.
    if (isKscTowerSessionId(sessionId)) {
      res.status(400).json({
        error: "KSC tower view-stream sessions cannot publish a vessel manifest"
      });
      return;
    }

    const parsed = vesselManifestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid vessel manifest", details: parsed.error.flatten() });
      return;
    }

    // Defensive: ensure every `parent` index is in range and no part claims
    // itself as parent. Cheap O(n) walk; cheaper than catching it in the
    // SVG renderer.
    const parts = parsed.data.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.parent !== -1) {
        if (p.parent < 0 || p.parent >= parts.length || p.parent === p.i) {
          res.status(400).json({ error: `Invalid parent index on part ${p.i}` });
          return;
        }
      }
      if (p.i !== i) {
        // Index field must match position; lets the renderer use the array
        // index directly and saves us building a Map at fetch time.
        res
          .status(400)
          .json({ error: `Part index mismatch at position ${i} (got ${p.i})` });
        return;
      }
    }
    if (
      parsed.data.rootPartIndex < 0 ||
      parsed.data.rootPartIndex >= parts.length
    ) {
      res.status(400).json({ error: "rootPartIndex out of range" });
      return;
    }

    const existing = await getSessionWithDevSharedBootstrap(sessionId, req.auth!.userId);
    if (!existing) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const devSharedOpen =
      sessionId === "dev-shared" &&
      (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
      env.DEV_OPEN_AUTH;
    if (!devSharedOpen && req.auth!.userId !== existing.pilotUserId) {
      res
        .status(403)
        .json({ error: "Only pilot can publish a vessel manifest for this session" });
      return;
    }

    putVesselManifest(sessionId, parsed.data);
    res.json({
      ok: true,
      sessionId,
      partCount: parts.length,
      idleTtlMs: VESSEL_MANIFEST_IDLE_TTL_MS
    });
  }
);

/**
 * Read endpoint for the web tile. Auth is "any session member or admin"
 * via the same `loadSessionIfAuthorized` helper used by chat / telemetry
 * fetch routes — controllers, spectators, and the pilot all see the same
 * schematic.
 *
 * Returns 404 (not "stale" 503) when the manifest hasn't arrived yet so
 * the web tile can render its "Awaiting manifest" placeholder; the LRU
 * sweeper handles the "pilot left ages ago" case.
 */
apiRouter.get("/tower/vessel-schematic/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  if (isKscTowerSessionId(sessionId)) {
    res.status(400).json({ error: "KSC tower view-stream sessions have no vessel manifest" });
    return;
  }

  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const rec = getVesselManifest(sessionId);
  if (!rec) {
    res.status(404).json({ error: "No manifest published for this session yet" });
    return;
  }

  res.json({
    ok: true,
    sessionId,
    uploadedAtMs: rec.uploadedAtMs,
    serverNowMs: Date.now(),
    idleTtlMs: VESSEL_MANIFEST_IDLE_TTL_MS,
    manifest: rec.json
  });
});

apiRouter.post("/session/:sessionId/livekit-token", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);

  const parsedBody = livekitTokenSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({
      error: "Invalid livekit-token payload",
      details: parsedBody.error.flatten()
    });
    return;
  }
  const flavor: "ops" | "booth" | "lobby_ops" = parsedBody.data?.flavor ?? "ops";

  if (!isLiveKitConfigured()) {
    res.status(503).json({
      error: "LiveKit is not configured on this backend",
      hint: "Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_WS_URL (wss://… from LiveKit Cloud) then restart."
    });
    return;
  }

  const userId = req.auth!.userId;

  // Lobby-only listen path: same LiveKit ops room as tower, but no session
  // roster membership required (still pilot+ and not guest — same bar as tuning
  // server radio from the web).
  if (flavor === "lobby_ops") {
    const access = await getUserAccess(userId);
    if (access.isBanned) {
      res.status(403).json({ error: "Banned users cannot access sessions" });
      return;
    }
    if (access.role === "guest") {
      res.status(403).json({
        error: "Guests cannot enter voice rooms",
        reason: "voice_room_guest_denied"
      });
      return;
    }
    if (!roleAtLeast(access.role, "pilot")) {
      res.status(403).json({
        error: "Lobby tower listen requires a pilot account or higher.",
        reason: "lobby_ops_role_denied"
      });
      return;
    }
    const lobbySession = await getSession(sessionId);
    if (!lobbySession || lobbySession.status === "closed" || sessionId === "dev-shared") {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const roomName = opsLiveKitRoomName(lobbySession.id);
    const kickRemaining = getKickCooldownRemainingSec(userId, roomName);
    if (kickRemaining > 0) {
      res.setHeader("Retry-After", String(kickRemaining));
      res.status(403).json({
        error: `Kicked from this room. Try again in ${kickRemaining}s.`,
        reason: "kick_cooldown",
        retryAfterSeconds: kickRemaining
      });
      return;
    }
    const canPublish = false;
    const canSubscribe = true;
    await ensureLiveKitRoom(roomName);
    const token = await issueLiveKitToken({
      userId,
      roomName,
      canPublish,
      canSubscribe,
      displayName: req.auth?.displayName,
      metadata: {
        sessionId: lobbySession.id,
        roomName: lobbySession.name ?? lobbySession.id,
        frequencyMhz: lobbySession.frequencyMhz ?? null,
        flavor: "lobby_ops"
      }
    });
    await logAction(userId, "livekit.token.issue", {
      sessionId: lobbySession.id,
      roomName,
      flavor: "lobby_ops",
      canPublish,
      canSubscribe
    });
    const wsUrl = token.wsUrl ?? getLiveKitWsUrl();
    if (!wsUrl) {
      res.status(503).json({
        error: "LiveKit WebSocket URL is missing",
        reason: "livekit_ws_url_missing",
        hint: "Set LIVEKIT_WS_URL to your project wss:// URL (not a placeholder). LIVEKIT_URL is used only as a fallback."
      });
      return;
    }
    res.json({
      ok: true,
      roomName,
      sessionName: lobbySession.name ?? lobbySession.id,
      frequencyMhz: lobbySession.frequencyMhz ?? null,
      flavor: "lobby_ops",
      canPublish,
      canSubscribe,
      token: token.token,
      wsUrl
    });
    return;
  }

  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) {
    return;
  }

  const roomName = flavor === "booth" ? boothLiveKitRoomName(session.id) : opsLiveKitRoomName(session.id);

  // Mod-issued kick cooldown: short-circuit before we do any LiveKit work so
  // a kicked client's auto-rejoin loop can't burn cycles on the SFU. The
  // cooldown is per-room, so a kick from ops doesn't gag the booth (and
  // vice-versa).
  const kickRemaining = getKickCooldownRemainingSec(req.auth!.userId, roomName);
  if (kickRemaining > 0) {
    res.setHeader("Retry-After", String(kickRemaining));
    res.status(403).json({
      error: `Kicked from this room. Try again in ${kickRemaining}s.`,
      reason: "kick_cooldown",
      retryAfterSeconds: kickRemaining
    });
    return;
  }

  const isPilot = session.pilotUserId === userId;
  const isAssignedTower = session.assignedTowerUserId === userId;
  const isSpectator = session.spectatorUserIds.includes(userId);
  const access = await getUserAccess(userId);
  const hasVoice = access.capabilities.has("voice:speak");
  const isMod = roleAtLeast(access.role, "mod");
  const isDevOpen = env.NODE_ENV !== "production" && env.DEV_OPEN_AUTH;
  const isServerRadioSession = isServerOwnedRadioSessionId(session.id);

  // Guests cannot enter ANY voice room (ops or booth) — same as before.
  if (access.role === "guest") {
    res.status(403).json({
      error: "Guests cannot enter voice rooms",
      reason: "voice_room_guest_denied"
    });
    return;
  }

  let canPublish: boolean;
  let canSubscribe: boolean;

  if (flavor === "booth") {
    // Booth room policy:
    //   - pilot is excluded entirely (they're not in the booth — that's the
    //     whole point of the booth) unless they're also a mod
    //   - guests excluded (already handled above)
    //   - assigned tower controller: publish + subscribe (the bridge seat)
    //   - registered spectators: publish + subscribe — but if the booth is
    //     gagged (`session.boothMuted`), they get subscribe-only until a
    //     moderator lifts the kill-switch
    //   - mods: always full publish (they can override the kill-switch)
    if (isPilot && !isMod) {
      res.status(403).json({
        error: "The booth is the spectator commentary channel — pilots aren't in it.",
        reason: "booth_pilot_denied"
      });
      return;
    }
    const isBoothMember = isAssignedTower || isSpectator || isMod;
    if (!isBoothMember) {
      res.status(403).json({
        error: "Not authorized for the booth (spectate this room first)",
        reason: "booth_subscribe_denied"
      });
      return;
    }
    const isModerator = isAssignedTower || isMod;
    const boothGagged = getSessionBoothMuted(session) && !isModerator;
    canPublish = hasVoice && !access.isMuted && !boothGagged;
    canSubscribe = true;
  } else {
    // Ops room policy:
    //   - legacy ad-hoc sessions keep the old pilot/assigned-tower publish rule
    //   - server radio sessions are open aviation frequencies, so any signed-in
    //     pilot/controller who has joined the channel may transmit
    //   - for normal sessions, only the assigned tower (+mods) may join ops voice
    //     from the web; pilots hear via the local voice bridge + KSP. The KSP
    //     bridge uses a dedicated LiveKit identity (e.g. ksp_bridge) and must
    //     always receive subscribe. Dev open-auth keeps the old roster-wide
    //     subscribe path for local testing.
    //   - lobby listen uses flavor `lobby_ops` (handled above), not this branch.
    canPublish =
      (isServerRadioSession
        ? roleAtLeast(access.role, "pilot")
        : isPilot || isAssignedTower || isDevOpen) &&
      hasVoice &&
      !access.isMuted;
    canSubscribe = isServerRadioSession
      ? roleAtLeast(access.role, "pilot")
      : isBridgeIdentity(userId) ||
        isAssignedTower ||
        isMod ||
        (isDevOpen && (isPilot || isAssignedTower || isSpectator));

    if (!canSubscribe) {
      res.status(403).json({
        error: "Not authorized for this room",
        reason: "voice_room_subscribe_denied"
      });
      return;
    }
  }

  await ensureLiveKitRoom(roomName);
  const token = await issueLiveKitToken({
    userId,
    roomName,
    canPublish,
    canSubscribe,
    displayName: req.auth?.displayName,
    metadata: {
      sessionId: session.id,
      roomName: session.name ?? session.id,
      frequencyMhz: session.frequencyMhz ?? null,
      flavor
    }
  });

  await logAction(userId, "livekit.token.issue", {
    sessionId: session.id,
    roomName,
    flavor,
    canPublish,
    canSubscribe
  });

  const wsUrl = token.wsUrl ?? getLiveKitWsUrl();
  if (!wsUrl) {
    res.status(503).json({
      error: "LiveKit WebSocket URL is missing",
      reason: "livekit_ws_url_missing",
      hint: "Set LIVEKIT_WS_URL to your project wss:// URL (not a placeholder). LIVEKIT_URL is used only as a fallback."
    });
    return;
  }

  res.json({
    ok: true,
    roomName,
    sessionName: session.name ?? session.id,
    frequencyMhz: session.frequencyMhz ?? null,
    flavor,
    canPublish,
    canSubscribe,
    boothMuted: flavor === "booth" ? getSessionBoothMuted(session) : undefined,
    token: token.token,
    wsUrl
  });
});

apiRouter.post("/report", requireAuth, writeLimiter, async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid report payload", details: parsed.error.flatten() });
    return;
  }

  const report = await addReport({
    reporterUserId: req.auth!.userId,
    targetUserId: parsed.data.targetUserId,
    sessionId: parsed.data.sessionId,
    reason: parsed.data.reason
  });

  await logAction(req.auth!.userId, "report.create", {
    reportId: report.id,
    targetUserId: report.targetUserId ?? null,
    sessionId: report.sessionId ?? null
  });

  res.status(201).json({ ok: true, reportId: report.id });
});

apiRouter.get("/admin/reports", requireAuth, requireRole("mod"), async (_req, res) => {
  res.json({ ok: true, reports: await listReports() });
});

/**
 * Invite-code admin surface. Owner-only because a code with `role: "controller"`
 * lets the holder mint a controller account themselves — that's a bigger
 * delegation than just creating a pilot, and we want it audited under one set
 * of hands.
 */
apiRouter.get("/admin/invite-codes", requireAuth, requireRole("owner"), async (_req, res) => {
  res.json({ ok: true, codes: listInviteCodes() });
});

apiRouter.post("/admin/invite-codes", requireAuth, requireRole("owner"), async (req, res) => {
  const parsed = inviteCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid invite payload", details: parsed.error.flatten() });
    return;
  }
  const created = await createInviteCode({
    createdByUserId: req.auth!.userId,
    role: parsed.data.role ?? null,
    maxUses: parsed.data.maxUses,
    expiresAt: parsed.data.expiresAt ?? null,
    label: parsed.data.label ?? ""
  });
  await logAction(req.auth!.userId, "admin.invite.create", {
    code: created.code,
    role: created.role,
    maxUses: created.maxUses,
    expiresAt: created.expiresAt,
    label: created.label
  });
  res.status(201).json({ ok: true, invite: created });
});

apiRouter.delete("/admin/invite-codes/:code", requireAuth, requireRole("owner"), async (req, res) => {
  const code = String(req.params.code ?? "").trim();
  if (!code) {
    res.status(400).json({ error: "Missing code path parameter" });
    return;
  }
  const removed = await revokeInviteCode(code);
  if (!removed) {
    res.status(404).json({ error: "Invite code not found", reason: "invite_unknown" });
    return;
  }
  await logAction(req.auth!.userId, "admin.invite.revoke", { code });
  res.json({ ok: true });
});

/**
 * Ban a user. Temp ban (with `durationSeconds`) requires `mod`. Permanent ban (omit duration)
 * requires `supermod`. Owner principal is rejected with 403 by `banUser` itself.
 */
apiRouter.post("/admin/ban", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ban payload", details: parsed.error.flatten() });
    return;
  }

  const callerRole = await effectiveRole(req);
  const isPerm = !parsed.data.durationSeconds;
  if (isPerm && !roleAtLeast(callerRole, "supermod")) {
    res.status(403).json({ error: "Permanent bans require supermod", have: callerRole });
    return;
  }

  try {
    await banUser(
      parsed.data.userId,
      req.auth!.userId,
      parsed.data.durationSeconds,
      parsed.data.reason
    );
  } catch (e) {
    res.status(403).json({ error: e instanceof Error ? e.message : "Ban failed" });
    return;
  }
  // Best-effort: kick any active LiveKit sessions immediately so the ban takes effect now,
  // not only when their currently-issued voice token expires.
  const kicked = await kickIdentityFromAllRooms(parsed.data.userId);
  await logAction(req.auth!.userId, "admin.ban", {
    userId: parsed.data.userId,
    durationSeconds: parsed.data.durationSeconds ?? null,
    reason: parsed.data.reason ?? null,
    livekitKicked: kicked
  });
  res.json({ ok: true, bans: await listBans(), livekitKicked: kicked });
});

/**
 * Soft kick: drop `userId` from a single LiveKit room (`tower-<sessionId>`)
 * and refuse to mint a new voice token for that same room until the cooldown
 * expires. Defaults to 5 minutes; mods can pass `durationSeconds` (max 1h).
 *
 * Owner principal is immune. Unlike ban, this does not write a row to `bans`
 * — it's an in-memory correction held in the livekit service. For lasting
 * enforcement use /admin/ban.
 */
apiRouter.post("/admin/kick", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = kickSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid kick payload", details: parsed.error.flatten() });
    return;
  }
  const targetAccess = await getUserAccess(parsed.data.userId);
  if (targetAccess.role === "owner") {
    res.status(403).json({ error: "Cannot kick the immune owner principal" });
    return;
  }
  const cooldownSec = parsed.data.durationSeconds ?? KICK_DEFAULT_COOLDOWN_SEC;
  const result = await kickIdentityFromRoom(parsed.data.userId, parsed.data.roomName, cooldownSec);
  await logAction(req.auth!.userId, "admin.kick", {
    userId: parsed.data.userId,
    roomName: parsed.data.roomName,
    durationSeconds: cooldownSec,
    reason: parsed.data.reason ?? null,
    livekitRemoved: result.removed
  });
  res.json({
    ok: true,
    userId: parsed.data.userId,
    roomName: parsed.data.roomName,
    cooldownSeconds: cooldownSec,
    cooldownExpiresAtMs: result.cooldownExpiresAtMs,
    livekitRemoved: result.removed
  });
});

apiRouter.post("/admin/mute", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = muteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mute payload", details: parsed.error.flatten() });
    return;
  }
  try {
    await muteUser(
      parsed.data.userId,
      parsed.data.durationSeconds,
      req.auth!.userId,
      parsed.data.reason
    );
  } catch (e) {
    res.status(403).json({ error: e instanceof Error ? e.message : "Mute failed" });
    return;
  }
  // Drop publish perms on every active room they're in so their mic cuts out within ~1s.
  const updated = await revokePublishForIdentity(parsed.data.userId);
  res.json({ ok: true, bans: await listBans(), livekitUpdated: updated });
});

/** IP-ban a guest by their guest_id; pulls the guest's stored IP from the `guests` row. */
apiRouter.post("/admin/ban-ip", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = banIpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ban-ip payload", details: parsed.error.flatten() });
    return;
  }
  const guest = await getGuestById(parsed.data.guestId);
  if (!guest) {
    res.status(404).json({ error: "Guest not found", guestId: parsed.data.guestId });
    return;
  }
  await banGuestIp(guest.id, guest.ip, req.auth!.userId, parsed.data.reason, parsed.data.durationSeconds);
  const kicked = await kickIdentityFromAllRooms(guest.id);
  res.json({ ok: true, bans: await listBans(), livekitKicked: kicked });
});

/**
 * Role grant, capped at the caller's own rank minus one. Owner is immune in both
 * directions: it can never be granted via API (set with OWNER_USER_ID) and the
 * immune owner principal can never be demoted. A caller can only grant roles
 * strictly below their own and can only modify targets currently strictly below
 * their own — so a mod can mint controllers/pilots but cannot promote anyone to
 * mod, supermod, or owner, and cannot rewrite another mod's role.
 */
apiRouter.post("/admin/role", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = setRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid role payload", details: parsed.error.flatten() });
    return;
  }
  const newRole = parsed.data.role as Role;
  if (ROLE_RANK[newRole] >= ROLE_RANK.owner) {
    res.status(400).json({ error: "Owner role is set via OWNER_USER_ID env, not API" });
    return;
  }
  const callerRole = await effectiveRole(req);
  if (ROLE_RANK[newRole] >= ROLE_RANK[callerRole]) {
    res.status(403).json({
      error: "Cannot grant a role at or above your own",
      have: callerRole,
      requested: newRole
    });
    return;
  }
  // Block rewriting peers/superiors. Look up the target's current effective role
  // (owner immunity, dev override, guest pinning are all handled here) and gate
  // on it the same way we gate the new role.
  const targetAccess = await getUserAccess(parsed.data.userId);
  if (ROLE_RANK[targetAccess.role] >= ROLE_RANK[callerRole]) {
    res.status(403).json({
      error: "Cannot change role of a user at or above your own",
      have: callerRole,
      target: targetAccess.role
    });
    return;
  }
  try {
    await setUserRole(parsed.data.userId, newRole, req.auth!.userId);
  } catch (e) {
    res.status(403).json({ error: e instanceof Error ? e.message : "Role change failed" });
    return;
  }
  res.json({
    ok: true,
    userId: parsed.data.userId,
    role: newRole,
    capabilities: [...capabilitiesFor(newRole)]
  });
});

/**
 * Owner-only password reset for a self-registered user. Generates (or accepts)
 * a new password, overwrites the stored hash, and returns the plaintext ONCE
 * in the response so the operator can relay it. Nothing is emailed; the value
 * is never persisted in plaintext anywhere.
 *
 * Only works against accounts in the registered-users store: env-managed
 * `WEB_LOGIN_USERS_JSON` users are operator-rotated by editing the env, and
 * guests have no password to reset.
 *
 * Owner-only (not mod / supermod): a password reset hijacks the account, which
 * is a higher-impact action than a temporary ban. We reserve it for the same
 * principal that gets to mint roles.
 */
apiRouter.post(
  "/admin/users/:userId/reset-password",
  requireAuth,
  requireRole("owner"),
  async (req, res) => {
    const userId = String(req.params.userId ?? "").trim();
    if (!userId) {
      res.status(400).json({ error: "Missing userId" });
      return;
    }
    const parsed = adminResetPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid reset payload", details: parsed.error.flatten() });
      return;
    }
    if (!isRegisteredUserId(userId)) {
      res.status(404).json({
        error: "No self-registered account with that id. Env-managed accounts are reset by editing WEB_LOGIN_USERS_JSON.",
        reason: "not_registered"
      });
      return;
    }
    // 18 random bytes → 24-char base64url. Long enough that brute-force is
    // hopeless even before argon2, short enough to read aloud / paste once.
    const generated = parsed.data.newPassword
      ?? randomBytes(18).toString("base64url");
    const ok = await adminResetRegisteredUserPassword(userId, generated);
    if (!ok) {
      res.status(404).json({ error: "Account not found.", reason: "not_found" });
      return;
    }
    await logAction(req.auth!.userId, "admin.resetPassword", { targetUserId: userId });
    res.json({
      ok: true,
      userId,
      // Returned once. The OwnerDesk UI shows it inline with a "copy" button
      // and a "this won't be shown again" note.
      newPassword: generated
    });
  }
);

apiRouter.get("/admin/logs", requireAuth, requireRole("mod"), async (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  res.json({ ok: true, logs: await listLogs(safeLimit) });
});

/**
 * Recent backend log lines from the in-memory ring buffer (see lib/serverLogBuffer.ts).
 * Designed for the AdminDesk "Server logs" tail: callers pass `?sinceSeq=` on each
 * subsequent poll to receive only the entries newer than the last `latestSeq` they saw.
 *
 * Query params:
 *   - limit:    1..1000 (default 200)
 *   - sinceSeq: integer; only return entries with seq > sinceSeq
 *   - level:    trace|debug|info|warn|error|fatal — minimum level to include
 *
 * Restricted to mod+ because backend log lines can leak userIds, IP fragments,
 * stack traces revealing module paths, etc. Anything that should be visible to
 * lower roles must use the audit `/admin/logs` endpoint above instead.
 */
apiRouter.get("/admin/server-logs", requireAuth, requireRole("mod"), (req, res) => {
  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
  const sinceSeqRaw = Number(req.query.sinceSeq ?? 0);
  const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? Math.floor(sinceSeqRaw) : 0;
  const levelParam = typeof req.query.level === "string" ? req.query.level.toLowerCase() : "";
  const minLevel: ServerLogLevel | undefined =
    levelParam === "trace" ||
    levelParam === "debug" ||
    levelParam === "info" ||
    levelParam === "warn" ||
    levelParam === "error" ||
    levelParam === "fatal"
      ? levelParam
      : undefined;
  const out = readLogEntries({ limit, sinceSeq, minLevel });
  res.json({ ok: true, ...out });
});

apiRouter.get("/admin/bans", requireAuth, requireRole("mod"), async (_req, res) => {
  res.json({ ok: true, bans: await listBans() });
});

/**
 * Returns the same payload shape as `GET /admin/sanctions`. Used by the
 * lift-* endpoints so the response includes a fresh snapshot the AdminDesk
 * can drop straight into its sanctions table cache without a follow-up GET.
 */
async function collectSanctions(): Promise<{
  bans: BanListEntry[];
  mutes: BanListEntry[];
  kickCooldowns: ReturnType<typeof listKickCooldowns>;
}> {
  const all = await listBans();
  return {
    bans: all.filter((entry) => entry.kind === "ban"),
    mutes: all.filter((entry) => entry.kind === "mute"),
    kickCooldowns: listKickCooldowns()
  };
}

/**
 * Unified active-sanctions feed for the AdminDesk "Active sanctions" table.
 * Splits the response so the UI can render bans, mutes and kick cooldowns
 * in the same row list with one fetch — instead of joining `/admin/bans` +
 * a hypothetical separate cooldown endpoint client-side every refresh.
 *
 * Bans/mutes come from `listBans()` (DB-backed when persistence is on,
 * falling back to the in-memory store). Kick cooldowns come from the
 * livekit service's in-memory map, since they intentionally don't survive
 * a process restart (see `kickCooldowns` in services/livekit.ts).
 */
apiRouter.get("/admin/sanctions", requireAuth, requireRole("mod"), async (_req, res) => {
  const all = await listBans();
  const bans = all.filter((entry) => entry.kind === "ban");
  const mutes = all.filter((entry) => entry.kind === "mute");
  const cooldowns = listKickCooldowns();
  res.json({ ok: true, bans, mutes, kickCooldowns: cooldowns });
});

/**
 * Lift a ban (incl. IP ban). Mod+ for temp bans; supermod+ required to lift
 * a permanent ban (one with no `expiresAt`) so a regular mod can't quietly
 * undo a senior decision. Returns 404-style 200 with `removed:false` when
 * there was no active ban — the UI surfaces that as "already lifted".
 */
apiRouter.post("/admin/unban", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = unbanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid unban payload", details: parsed.error.flatten() });
    return;
  }
  // Look up the existing ban so we can enforce the "perm bans need supermod
  // to lift" rule — without this, a mod who can only issue 24h bans could
  // wipe out a supermod's permanent ban with a single click.
  const existing = (await listBans()).find(
    (entry) => entry.userId === parsed.data.userId && entry.kind === "ban"
  );
  if (existing && !existing.expiresAt) {
    const callerRole = await effectiveRole(req);
    if (!roleAtLeast(callerRole, "supermod")) {
      res.status(403).json({ error: "Lifting a permanent ban requires supermod", have: callerRole });
      return;
    }
  }
  const removed = await unbanUser(parsed.data.userId, req.auth!.userId);
  res.json({ ok: true, removed, sanctions: await collectSanctions() });
});

/**
 * Lift an active mute. Restores publish perms across every room the user
 * is currently in so the mic comes back without forcing a reconnect.
 */
apiRouter.post("/admin/unmute", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = unmuteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid unmute payload", details: parsed.error.flatten() });
    return;
  }
  const removed = await unmuteUser(parsed.data.userId, req.auth!.userId);
  const restored = removed ? await restorePublishForIdentity(parsed.data.userId) : 0;
  res.json({ ok: true, removed, livekitRestored: restored, sanctions: await collectSanctions() });
});

/**
 * Clear a kick cooldown so the user can rejoin before the timer runs out.
 * `roomName` omitted clears every cooldown for that identity at once
 * (handy when an over-eager mod kicked the same person from both
 * tower-<sid> and tower-<sid>-booth and the operator wants to undo both).
 */
apiRouter.post("/admin/clear-kick-cooldown", requireAuth, requireRole("mod"), async (req, res) => {
  const parsed = clearCooldownSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid clear-kick-cooldown payload", details: parsed.error.flatten() });
    return;
  }
  const cleared = clearKickCooldown(parsed.data.userId, parsed.data.roomName);
  await logAction(req.auth!.userId, "admin.kick.clear", {
    userId: parsed.data.userId,
    roomName: parsed.data.roomName ?? null,
    cleared
  });
  res.json({ ok: true, cleared, sanctions: await collectSanctions() });
});

/** Operational tower sessions (not closed). Mods see who is in the loop; pilots never pick these. */
apiRouter.get("/admin/rooms/tower", requireAuth, requireRole("mod"), async (req, res) => {
  const all = await listSessionsMerged();
  const towerRooms = all.filter((s) => s.status !== "closed");
  const closedCount = all.filter((s) => s.status === "closed").length;
  await logAction(req.auth!.userId, "admin.rooms.tower.view", { active: towerRooms.length, closed: closedCount });
  res.json({ ok: true, rooms: towerRooms, closedSessionCount: closedCount });
});

apiRouter.get("/admin/rooms/chat", requireAuth, requireRole("mod"), async (req, res) => {
  const rooms = await listChatRoomSummariesAdmin();
  await logAction(req.auth!.userId, "admin.rooms.chat.view", { count: rooms.length });
  res.json({ ok: true, rooms });
});

/**
 * Resolver lookup for the admin Users panel: configured web users, the KSP
 * voice-bridge identities, and any guests we've seen this process. The web
 * client uses this to (a) hide bridge identities from the derived users list,
 * and (b) render real display names instead of opaque internal userIds.
 */
apiRouter.get("/admin/principals", requireAuth, requireRole("mod"), async (_req, res) => {
  const principals = await listAdminPrincipals();
  res.json({ ok: true, principals });
});

// ---------------------------------------------------------------------------
// ATC roleplay: countdown, scoring, profile, checklist, preview-event.
// ---------------------------------------------------------------------------

const COUNTDOWN_MIN_SEC = 3;
const COUNTDOWN_MAX_SEC = 60;
const COUNTDOWN_STALE_GRACE_SEC = 5; // T+5s after T-0 is still "active" so the audio plays through.

const countdownStartSchema = z.object({
  /** Defaults to a 10-second NASA-style hold. Capped to a sane range. */
  seconds: z.number().int().min(COUNTDOWN_MIN_SEC).max(COUNTDOWN_MAX_SEC).default(10)
});

const SCORE_KIND_VALUES = [
  "controller_reward",
  "controller_penalty",
  "hot_mic",
  "good_comms",
  "ignored_atc",
  "pro_comms"
] as const;
const POINTS_CAP = 25;
const scoreSchema = z.object({
  targetUserId: z.string().min(1),
  kind: z.enum(SCORE_KIND_VALUES),
  points: z.number().int().min(-POINTS_CAP).max(POINTS_CAP),
  label: z.string().min(1).max(120)
});

const checklistToggleSchema = z.object({
  side: z.enum(["pilot", "controller"]),
  itemId: z.string().min(1).max(64)
});

const previewEventSchema = z.object({
  kind: z.string().min(1).max(48),
  points: z.number().int().min(-POINTS_CAP).max(POINTS_CAP),
  label: z.string().min(1).max(120),
  dedupeBucket: z.string().min(1).max(96)
});

/**
 * Idempotent: refuses to start a fresh countdown while one is already running. The "running"
 * window is `[startsAt, startsAt + length + COUNTDOWN_STALE_GRACE_SEC]`; outside that window
 * the previous countdown is considered finished and a new Start is allowed.
 */
apiRouter.post(
  "/session/:sessionId/countdown/start",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const parsed = countdownStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid countdown payload", details: parsed.error.flatten() });
      return;
    }

    if (session.countdownStartsAt && session.countdownLengthSec != null) {
      const startMs = Date.parse(session.countdownStartsAt);
      const endMs = startMs + (session.countdownLengthSec + COUNTDOWN_STALE_GRACE_SEC) * 1000;
      if (Date.now() < endMs) {
        res.status(409).json({
          error: "Countdown already running",
          startsAt: session.countdownStartsAt,
          lengthSec: session.countdownLengthSec
        });
        return;
      }
    }

    const result = await startCountdown(sessionId, parsed.data.seconds);
    await appendSessionMessage(
      sessionId,
      "system",
      `[COUNTDOWN] T-${parsed.data.seconds} started`
    );
    await logAction(req.auth!.userId, "session.countdown.start", { sessionId, ...parsed.data });
    res.json({ ok: true, ...result });
  }
);

apiRouter.post(
  "/session/:sessionId/countdown/scrub",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    await clearCountdown(sessionId);
    await appendSessionMessage(sessionId, "system", `[COUNTDOWN] SCRUB`);
    await logAction(req.auth!.userId, "session.countdown.scrub", { sessionId });
    res.json({ ok: true });
  }
);

/**
 * Range-safety placeholder: any session participant with `chat:session` may clear the
 * countdown record during a **60s window after nominal T-0** (same `clearCountdown` as Scrub).
 * Outside that window use normal controller Scrub before liftoff, or wait for the session
 * record to age out on the next countdown start path.
 */
const POST_LIFTOFF_ABORT_WINDOW_MS = 60_000;
apiRouter.post(
  "/session/:sessionId/countdown/post-liftoff-abort",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    if (!session.countdownStartsAt || session.countdownLengthSec == null) {
      res.status(400).json({ error: "No active countdown to abort" });
      return;
    }

    const startMs = Date.parse(session.countdownStartsAt);
    if (!Number.isFinite(startMs)) {
      res.status(400).json({ error: "Invalid countdown start timestamp" });
      return;
    }

    const liftoffMs = startMs + session.countdownLengthSec * 1000;
    const t = Date.now();
    if (t < liftoffMs) {
      res.status(400).json({
        error: "Liftoff not reached yet — controller can Scrub during the count."
      });
      return;
    }
    if (t > liftoffMs + POST_LIFTOFF_ABORT_WINDOW_MS) {
      res.status(400).json({
        error: "Post-liftoff abort window has closed (60s after T-0)."
      });
      return;
    }

    const callerId = req.auth!.userId;
    const who =
      callerId === session.pilotUserId && session.callsign
        ? session.callsign
        : `User ${callerId.slice(0, 8)}`;

    await clearCountdown(sessionId);
    await appendSessionMessage(
      sessionId,
      callerId,
      `[COUNTDOWN] POST-LIFTOFF ABORT (${who})`
    );
    await logAction(callerId, "session.countdown.postLiftoffAbort", { sessionId });
    res.json({ ok: true });
  }
);

/**
 * Pilot-side ping: either a **launch countdown** request (rockets) or a **takeoff clearance**
 * alert (planes / rovers). Throttled per-(session,user) to 8s.
 *
 * - `kind: "launch"` (default): sets ephemeral `countdownRequest`, chat `[REQUEST] … ready for countdown`.
 *   Blocked while a countdown is already running (409).
 * - `kind: "takeoff"`: sets ephemeral `takeoffRequest` (clears `countdownRequest`), chat
 *   `[ALERT] … requests takeoff clearance` — not blocked by an active rocket countdown (still rate-limited).
 *
 * The controller still presses Start on the web panel for an actual countdown; this route is only the pilot ping.
 */
const COUNTDOWN_REQUEST_COOLDOWN_MS = 8000;
const countdownRequestCooldown = new Map<string, number>();
apiRouter.post(
  "/session/:sessionId/countdown/request",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const kind = body.kind === "takeoff" ? "takeoff" : "launch";

    if (kind === "launch" && session.countdownStartsAt && session.countdownLengthSec != null) {
      const startMs = Date.parse(session.countdownStartsAt);
      const endMs = startMs + (session.countdownLengthSec + COUNTDOWN_STALE_GRACE_SEC) * 1000;
      if (Date.now() < endMs) {
        res.status(409).json({ error: "Countdown already running" });
        return;
      }
    }

    const callerId = req.auth!.userId;
    const cooldownKey = `${sessionId}:${callerId}`;
    const lastAt = countdownRequestCooldown.get(cooldownKey) ?? 0;
    if (Date.now() - lastAt < COUNTDOWN_REQUEST_COOLDOWN_MS) {
      res.status(429).json({ error: "Slow down — wait a few seconds before requesting again" });
      return;
    }
    countdownRequestCooldown.set(cooldownKey, Date.now());

    // We don't have a `users.display_name` column yet — fall back to the session callsign when
    // the requester is the assigned pilot, otherwise a short id slice. The controller cares more
    // about "someone in this session pinged me" than about who exactly.
    const who =
      callerId === session.pilotUserId && session.callsign
        ? session.callsign
        : `Pilot ${callerId.slice(0, 8)}`;
    const requestAt = new Date().toISOString();

    if (kind === "takeoff") {
      await setTakeoffRequest(sessionId, { at: requestAt, byUserId: callerId, label: who });
      await appendSessionMessage(
        sessionId,
        callerId,
        `[ALERT] ${who} requests takeoff clearance`
      );
      await logAction(callerId, "session.takeoff.request", { sessionId });
      const updated = await getSession(sessionId);
      res.json({
        ok: true,
        kind: "takeoff" as const,
        takeoffRequest: updated?.takeoffRequest ?? { at: requestAt, byUserId: callerId, label: who }
      });
      return;
    }

    await setCountdownRequest(sessionId, { at: requestAt, byUserId: callerId, label: who });
    await appendSessionMessage(sessionId, callerId, `[REQUEST] ${who} ready for countdown`);
    await logAction(callerId, "session.countdown.request", { sessionId });
    res.json({ ok: true, countdownRequest: { at: requestAt, byUserId: callerId, label: who } });
  }
);

const pilotPendingHandleSchema = z.object({
  target: z.enum(["takeoff", "launch"]),
  action: z.enum(["grant", "dismiss"])
});

/**
 * Controller resolves structured pilot pings: **takeoff** (grant clearance or dismiss) or
 * **launch** countdown request (dismiss only — use `POST …/countdown/start` to grant).
 */
apiRouter.post(
  "/session/:sessionId/pilot-pending/handle",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const parsed = pilotPendingHandleSchema.safeParse(
      req.body && typeof req.body === "object" ? req.body : {}
    );
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const { target, action } = parsed.data;
    const callerId = req.auth!.userId;

    if (target === "launch" && action === "grant") {
      res.status(400).json({
        error: "To approve a launch countdown request, use POST …/countdown/start (Start T-10)."
      });
      return;
    }

    if (target === "takeoff") {
      if (!session.takeoffRequest) {
        res.json({ ok: true, changed: false });
        return;
      }
      await clearPendingTakeoffRequest(sessionId);
      if (action === "grant") {
        await recordTakeoffClearanceGranted(sessionId);
        await appendSessionMessage(sessionId, callerId, "[CLEARANCE] Cleared for takeoff");
        await logAction(callerId, "session.takeoff.grant", { sessionId });
      } else {
        await appendSessionMessage(sessionId, callerId, "[TOWER] Takeoff request dismissed");
        await logAction(callerId, "session.takeoff.dismiss", { sessionId });
      }
      res.json({ ok: true, changed: true });
      return;
    }

    if (!session.countdownRequest) {
      res.json({ ok: true, changed: false });
      return;
    }
    await clearPendingCountdownRequest(sessionId);
    await appendSessionMessage(sessionId, callerId, "[TOWER] Launch countdown request dismissed");
    await logAction(callerId, "session.countdown.request.dismiss", { sessionId });
    res.json({ ok: true, changed: true });
  }
);

apiRouter.post(
  "/session/:sessionId/clearance",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const parsed = clearancePostSchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid clearance payload", details: parsed.error.flatten() });
      return;
    }
    const updated = await setSessionClearance(sessionId, parsed.data.clearance, parsed.data.status);
    await logAction(req.auth!.userId, "session.clearance.set", {
      sessionId,
      clearance: parsed.data.clearance,
      status: parsed.data.status
    });
    res.json({ ok: true, session: updated });
  }
);

apiRouter.get("/tower/staging-move-presets", requireAuth, (_req, res) => {
  res.json({ ok: true, presets: STAGING_MOVE_PRESETS });
});

apiRouter.post(
  "/session/:sessionId/staging-move",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const parsed = stagingMoveIssueSchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid staging-move payload", details: parsed.error.flatten() });
      return;
    }
    const preset = parsed.data.preset;
    const label = STAGING_MOVE_PRESETS.find((p) => p.id === preset)?.label ?? preset;
    const issuedAt = new Date().toISOString();
    const issuedByUserId = req.auth!.userId;
    const updated = await setSessionStagingMove(sessionId, { preset, label, issuedAt, issuedByUserId });
    await appendSessionMessage(sessionId, issuedByUserId, `[TOWER] Ramp position — ${label} (${preset})`);
    await logAction(issuedByUserId, "session.stagingMove.issue", { sessionId, preset });
    res.json({ ok: true, session: updated });
  }
);

apiRouter.post(
  "/session/:sessionId/staging-move/clear",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const updated = await clearSessionStagingMove(sessionId);
    await appendSessionMessage(sessionId, req.auth!.userId, "[TOWER] Ramp position cleared");
    await logAction(req.auth!.userId, "session.stagingMove.clear", { sessionId });
    res.json({ ok: true, session: updated });
  }
);

apiRouter.post(
  "/session/:sessionId/expected-runway",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const parsed = expectedRunwaySchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid expected runway payload", details: parsed.error.flatten() });
      return;
    }
    const updated = await setExpectedLandingRunway(sessionId, parsed.data.runway);
    await logAction(req.auth!.userId, "session.expectedRunway.set", { sessionId, runway: parsed.data.runway });
    res.json({ ok: true, session: updated });
  }
);

apiRouter.post(
  "/session/:sessionId/runway-occupancy",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const parsed = runwayOccupancyPostSchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid runway occupancy payload", details: parsed.error.flatten() });
      return;
    }
    setRunwayManualOverride(parsed.data.bodyName, parsed.data.runwayId, {
      occupied: parsed.data.occupied,
      bySessionId: undefined
    });
    await logAction(req.auth!.userId, "tower.runway.manual", { sessionId, ...parsed.data });
    publishLiveSnapshotEvent({ topic: "active-aircraft" });
    res.json({ ok: true });
  }
);

/** Controller-issued reward/penalty. Always `source='controller'`, dedupe disabled. */
apiRouter.post(
  "/session/:sessionId/score",
  requireAuth,
  requireCapability("controller:assume"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const parsed = scoreSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid score payload", details: parsed.error.flatten() });
      return;
    }

    const ev = await awardEvent({
      sessionId,
      targetUserId: parsed.data.targetUserId,
      actorUserId: req.auth!.userId,
      kind: parsed.data.kind,
      points: parsed.data.points,
      label: parsed.data.label,
      source: "controller"
    });
    await appendSessionMessage(
      sessionId,
      "system",
      `[${parsed.data.kind.toUpperCase()}] ${parsed.data.label} (${parsed.data.points >= 0 ? "+" : ""}${parsed.data.points})`
    );
    await logAction(req.auth!.userId, "session.score", {
      sessionId,
      targetUserId: parsed.data.targetUserId,
      kind: parsed.data.kind,
      points: parsed.data.points
    });
    res.status(201).json({ ok: true, event: ev });
  }
);

apiRouter.get("/session/:sessionId/scorecard", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) return;
  const scorecard = await getSessionScorecard(sessionId);
  res.json({ ok: true, ...scorecard });
});

apiRouter.get("/users/:userId/profile", requireAuth, async (req, res) => {
  const userId = String(req.params.userId);
  const profile = await getUserProfile(userId);
  res.json({ ok: true, profile });
});

/**
 * Toggle a pilot or controller checklist item. The route enforces side-vs-role:
 * a pilot cannot tick controller items and vice-versa. Mods can toggle either side
 * (operational override for stuck sessions).
 */
apiRouter.post(
  "/session/:sessionId/checklist/toggle",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const parsed = checklistToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid checklist payload", details: parsed.error.flatten() });
      return;
    }

    const callerId = req.auth!.userId;
    const access = await getUserAccess(callerId);
    const isMod = roleAtLeast(access.role, "mod");
    const isPilotForSession = session.pilotUserId === callerId;
    const isControllerForSession = session.assignedTowerUserId === callerId;
    const allowed =
      isMod ||
      (parsed.data.side === "pilot" && isPilotForSession) ||
      (parsed.data.side === "controller" && isControllerForSession);
    if (!allowed) {
      res.status(403).json({ error: "Cannot toggle checklist items for the other side" });
      return;
    }

    const { state: next, sideJustCompleted } = await toggleChecklistItem(
      sessionId,
      parsed.data.side,
      parsed.data.itemId,
      callerId,
      effectivePhases(session).phases
    );
    const isDone = !!next[parsed.data.side]?.[parsed.data.itemId];
    await appendSessionMessage(
      sessionId,
      "system",
      `[CHECKLIST] ${parsed.data.side}: ${parsed.data.itemId} ${isDone ? "✓" : "✗"}`
    );
    if (sideJustCompleted) {
      await appendSessionMessage(
        sessionId,
        "system",
        `[CHECKLIST] ${parsed.data.side} side complete ✓`
      );
    }
    // Synthesize a SessionRecord with the freshly-toggled state so we can reuse the
    // unified payload helper. `checklistState` is also kept in the response so the
    // existing web `toggle()` handler (reads `r.data.checklistState`) keeps working.
    const synthetic: SessionRecord = { ...session, checklistState: next };
    const payload = await checklistPayload(synthetic);
    emitChecklistEvent({
      kind: "state",
      sessionId,
      at: new Date().toISOString(),
      itemIds: [parsed.data.itemId],
      byUserId: callerId
    });
    res.json({ ok: true, checklistState: next, ...payload });
  }
);

/**
 * Client-preview event write. Frontend rules.ts mirrors the server detector and posts here so
 * the UI flashes immediately. The backend's auto detector will overwrite this row using the
 * same `dedupeBucket` (UNIQUE collision) when the next telemetry sample fires the same rule.
 */
apiRouter.post(
  "/session/:sessionId/preview-event",
  requireAuth,
  requireCapability("chat:session"),
  writeLimiter,
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;

    const parsed = previewEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preview payload", details: parsed.error.flatten() });
      return;
    }

    // Only the pilot may write preview rows for themselves; otherwise other clients could
    // forge achievements for arbitrary users.
    if (session.pilotUserId !== req.auth!.userId) {
      res.status(403).json({ error: "Only the pilot can post preview events for this session" });
      return;
    }

    const ev = await awardEvent({
      sessionId,
      targetUserId: session.pilotUserId,
      kind: parsed.data.kind,
      points: parsed.data.points,
      label: parsed.data.label,
      source: "client_preview",
      dedupeBucket: parsed.data.dedupeBucket
    });
    res.status(201).json({ ok: true, event: ev });
  }
);

// ---------------------------------------------------------------------------
// Checklist templates + per-session checklist editing.
//
// Wire model:
//   - GET    /v1/session/:sessionId/checklist            -> { phases, state, source, defaults }
//   - PUT    /v1/session/:sessionId/checklist/phases     -> replace session override (apply tpl)
//   - DELETE /v1/session/:sessionId/checklist/phases     -> clear override (back to defaults)
//   - POST   /v1/session/:sessionId/checklist/items      -> add { phaseId, side, label }
//   - PATCH  /v1/session/:sessionId/checklist/items/:id  -> rename { label }
//   - DELETE /v1/session/:sessionId/checklist/items/:id  -> remove
//   - POST   /v1/session/:sessionId/checklist/send       -> apply tpl + post ACARS announce
//
//   - GET    /v1/checklist/templates?craft=...           -> list mine (+ for craft)
//   - POST   /v1/checklist/templates                     -> create
//   - PUT    /v1/checklist/templates/:id                 -> update
//   - DELETE /v1/checklist/templates/:id                 -> delete
//
// Permissions: session edits require pilot/controller (or mod) for THIS session — same
// rule as the existing checklist-toggle endpoint. Template CRUD is per-user (the owner).
// ---------------------------------------------------------------------------

const checklistAutoRuleSchema = z
  .object({
    kind: z.literal("telemetry"),
    expr: z.string().min(1).max(200)
  })
  .optional();

const checklistItemDefSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(200),
  autoRule: checklistAutoRuleSchema
});

const checklistPhaseDefSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  pilot: z.array(checklistItemDefSchema).max(40),
  controller: z.array(checklistItemDefSchema).max(40)
});

const checklistPhasesSchema = z.array(checklistPhaseDefSchema).max(20);

const checklistTemplateBodySchema = z.object({
  scope: z.enum(["user", "craft", "global"]).default("user"),
  craftName: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  isDefault: z.boolean().optional(),
  phases: checklistPhasesSchema
});

const checklistTemplatePatchSchema = z.object({
  scope: z.enum(["user", "craft", "global"]).optional(),
  craftName: z.string().max(120).nullable().optional(),
  name: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  phases: checklistPhasesSchema.optional()
});

const checklistAddItemSchema = z.object({
  phaseId: z.string().min(1).max(64),
  side: z.enum(["pilot", "controller"]),
  label: z.string().min(1).max(200),
  autoRule: checklistAutoRuleSchema
});

const checklistRenameItemSchema = z.object({
  label: z.string().min(1).max(200),
  autoRule: checklistAutoRuleSchema.nullable().optional()
});

const checklistApplyPhasesSchema = z.object({
  phases: checklistPhasesSchema
});

const checklistAddPhaseSchema = z.object({
  title: z.string().min(1).max(80),
  index: z.number().int().min(0).max(20).optional()
});

const checklistRenamePhaseSchema = z.object({
  title: z.string().min(1).max(80)
});

const checklistReorderPhasesSchema = z.object({
  order: z.array(z.string().min(1).max(64)).max(20)
});

const checklistSendSchema = z.object({
  templateId: z.string().min(1).max(64).optional(),
  phases: checklistPhasesSchema.optional(),
  note: z.string().max(200).optional()
});

const checklistAckSchema = z.object({
  sendId: z.string().min(1).max(64)
});

/**
 * Permission gate shared by all session-checklist edit routes. Mirrors the rule used by
 * `/checklist/toggle`: pilot or assigned controller for THIS session, or any mod+.
 */
async function requireSessionChecklistEditor(
  req: Request,
  res: Response,
  session: SessionRecord
): Promise<boolean> {
  const callerId = req.auth!.userId;
  const access = await getUserAccess(callerId);
  const isMod = roleAtLeast(access.role, "mod");
  const isPilotForSession = session.pilotUserId === callerId;
  const isControllerForSession = session.assignedTowerUserId === callerId;
  if (isMod || isPilotForSession || isControllerForSession) return true;
  res.status(403).json({ error: "Not allowed to edit this session's checklist" });
  return false;
}

function effectivePhases(session: SessionRecord): {
  phases: ChecklistPhaseDef[];
  source: "session" | "default";
} {
  if (session.checklistPhases && session.checklistPhases.length > 0) {
    return { phases: session.checklistPhases, source: "session" };
  }
  return { phases: DEFAULT_CHECKLIST_PHASES, source: "default" };
}

/**
 * Build the response shape every checklist read/write returns. Including the JsonUtility-friendly
 * `doneIds` arrays here (not just `state`) lets the in-game plugin reuse this exact payload
 * after every mutation without losing local check-marks. The web modal only reads `state`.
 *
 * Async because we lazily fetch the most-recent send receipt (for ack badges) — that is a
 * cheap point lookup but still I/O.
 */
async function checklistPayload(session: SessionRecord): Promise<{
  phases: ChecklistPhaseDef[];
  source: "session" | "default";
  state: ChecklistState;
  doneIds: { pilot: string[]; controller: string[] };
  latestSend: ChecklistSendRecord | null;
}> {
  const { phases, source } = effectivePhases(session);
  const state: ChecklistState = session.checklistState ?? { pilot: {}, controller: {} };
  const latestSend = (await latestChecklistSend(session.id)) ?? null;
  return {
    phases,
    source,
    state,
    doneIds: {
      pilot: Object.keys(state.pilot ?? {}),
      controller: Object.keys(state.controller ?? {})
    },
    latestSend
  };
}

apiRouter.get(
  "/session/:sessionId/checklist",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    res.json({
      ok: true,
      ...(await checklistPayload(session)),
      defaults: DEFAULT_CHECKLIST_PHASES,
      pilotUserId: session.pilotUserId,
      assignedTowerUserId: session.assignedTowerUserId,
      craftName: session.telemetry?.craftName
    });
  }
);

/**
 * SSE: pushes a small JSON envelope every time this session's checklist mutates. Replaces
 * the 4-second poll the modal used. EventSource cannot send Authorization headers, so this
 * stream relies on the HttpOnly web session cookie (`withCredentials`) instead of putting
 * bearer credentials in the URL.
 *
 * Heartbeat: a `:ping` comment line every 25s keeps proxies (nginx/Cloudflare) from
 * dropping the long-lived connection.
 */
apiRouter.get("/session/:sessionId/checklist/stream", async (req, res) => {
  // Reuse the standard auth middleware on this manually-mounted route by invoking it
  // directly. requireAuth + capability check use the same chain as every other route.
  await new Promise<void>((resolve, reject) => {
    requireAuth(req, res, (err) => (err ? reject(err) : resolve()));
  }).catch(() => {
    /* requireAuth already wrote a response */
  });
  if (res.headersSent) return;
  await new Promise<void>((resolve, reject) => {
    requireCapability("chat:session")(req, res, (err) => (err ? reject(err) : resolve()));
  }).catch(() => {});
  if (res.headersSent) return;

  const sessionId = String(req.params.sessionId);
  const session = await loadSessionIfAuthorized(req, res, sessionId);
  if (!session) return;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const unsubscribe = subscribeChecklistEvents(sessionId, (ev) => {
    res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(`:ping ${Date.now()}\n\n`);
  }, 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      /* socket already closed */
    }
  });
});

apiRouter.put(
  "/session/:sessionId/checklist/phases",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistApplyPhasesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid phases payload", details: parsed.error.flatten() });
      return;
    }
    let cleaned: ChecklistPhaseDef[];
    try {
      cleaned = sanitizeChecklistPhases(parsed.data.phases);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const updated = await setSessionChecklistPhases(sessionId, cleaned);
    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await appendSessionMessage(sessionId, "system", `[CHECKLIST] applied (${cleaned.length} phases)`);
    await logAction(req.auth!.userId, "session.checklist.phases.set", {
      sessionId,
      phases: cleaned.length
    });
    emitChecklistEvent({
      kind: "state",
      sessionId,
      at: new Date().toISOString(),
      byUserId: req.auth!.userId
    });
    res.json({ ok: true, ...(await checklistPayload(updated)) });
  }
);

apiRouter.delete(
  "/session/:sessionId/checklist/phases",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const updated = await setSessionChecklistPhases(sessionId, null);
    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await appendSessionMessage(sessionId, "system", `[CHECKLIST] reset to defaults`);
    await logAction(req.auth!.userId, "session.checklist.phases.reset", { sessionId });
    emitChecklistEvent({
      kind: "state",
      sessionId,
      at: new Date().toISOString(),
      byUserId: req.auth!.userId
    });
    res.json({ ok: true, ...(await checklistPayload(updated)) });
  }
);

// Phase-level CRUD on the per-session override. POST creates a single phase (vs PUT
// /phases which replaces the entire array). Reorder uses PUT /phases/order so it doesn't
// shadow the replace-phases route.
apiRouter.post(
  "/session/:sessionId/checklist/phases",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistAddPhaseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid phase payload", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await addSessionChecklistPhase({
        sessionId,
        basePhases: effectivePhases(session).phases,
        title: parsed.data.title,
        index: parsed.data.index
      });
      if (!result) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await logAction(req.auth!.userId, "session.checklist.phase.add", {
        sessionId,
        phaseId: result.phaseId
      });
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.status(201).json({
        ok: true,
        phaseId: result.phaseId,
        ...(await checklistPayload(result.session))
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.patch(
  "/session/:sessionId/checklist/phases/:phaseId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const phaseId = String(req.params.phaseId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistRenamePhaseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid rename payload", details: parsed.error.flatten() });
      return;
    }
    try {
      const updated = await renameSessionChecklistPhase({
        sessionId,
        basePhases: effectivePhases(session).phases,
        phaseId,
        title: parsed.data.title
      });
      if (!updated) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await logAction(req.auth!.userId, "session.checklist.phase.rename", { sessionId, phaseId });
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.json({ ok: true, ...(await checklistPayload(updated)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.delete(
  "/session/:sessionId/checklist/phases/:phaseId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const phaseId = String(req.params.phaseId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    try {
      const updated = await removeSessionChecklistPhase({
        sessionId,
        basePhases: effectivePhases(session).phases,
        phaseId
      });
      if (!updated) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await logAction(req.auth!.userId, "session.checklist.phase.remove", { sessionId, phaseId });
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.json({ ok: true, ...(await checklistPayload(updated)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.put(
  "/session/:sessionId/checklist/phases/order",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistReorderPhasesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid reorder payload", details: parsed.error.flatten() });
      return;
    }
    try {
      const updated = await reorderSessionChecklistPhases({
        sessionId,
        basePhases: effectivePhases(session).phases,
        order: parsed.data.order
      });
      if (!updated) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await logAction(req.auth!.userId, "session.checklist.phase.reorder", { sessionId });
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.json({ ok: true, ...(await checklistPayload(updated)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.post(
  "/session/:sessionId/checklist/items",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistAddItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid item payload", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await addSessionChecklistItem({
        sessionId,
        basePhases: effectivePhases(session).phases,
        phaseId: parsed.data.phaseId,
        side: parsed.data.side,
        label: parsed.data.label
      });
      if (!result) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      // Attach the optional autoRule via a follow-up rename pass — keeps the repository
      // helper signature small while still letting clients post a rule with the create.
      let finalSession = result.session;
      if (parsed.data.autoRule) {
        const updated = await renameSessionChecklistItem({
          sessionId,
          basePhases: effectivePhases(finalSession).phases,
          itemId: result.itemId,
          label: parsed.data.label,
          autoRule: parsed.data.autoRule
        });
        if (updated) finalSession = updated;
      }
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.status(201).json({
        ok: true,
        itemId: result.itemId,
        ...(await checklistPayload(finalSession))
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.patch(
  "/session/:sessionId/checklist/items/:itemId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const itemId = String(req.params.itemId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistRenameItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid rename payload", details: parsed.error.flatten() });
      return;
    }
    try {
      const updated = await renameSessionChecklistItem({
        sessionId,
        basePhases: effectivePhases(session).phases,
        itemId,
        label: parsed.data.label,
        autoRule:
          parsed.data.autoRule === null
            ? null
            : (parsed.data.autoRule as { kind: "telemetry"; expr: string } | undefined)
      });
      if (!updated) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.json({ ok: true, ...(await checklistPayload(updated)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.delete(
  "/session/:sessionId/checklist/items/:itemId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const itemId = String(req.params.itemId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    try {
      const updated = await removeSessionChecklistItem({
        sessionId,
        basePhases: effectivePhases(session).phases,
        itemId
      });
      if (!updated) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      emitChecklistEvent({
        kind: "state",
        sessionId,
        at: new Date().toISOString(),
        byUserId: req.auth!.userId
      });
      res.json({ ok: true, ...(await checklistPayload(updated)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

/**
 * "Send to tower" — apply a saved template (or an inline phases array) to the session
 * AND post a system ACARS announcement so the controller sees the swap in chat.
 *
 * Either `templateId` (resolved server-side, must be owned by caller) or `phases`
 * (already-shaped inline payload) is required.
 */
apiRouter.post(
  "/session/:sessionId/checklist/send",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    if (!(await requireSessionChecklistEditor(req, res, session))) return;
    const parsed = checklistSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid send payload", details: parsed.error.flatten() });
      return;
    }

    let phases: ChecklistPhaseDef[] | null = null;
    let templateLabel = "custom";
    let resolvedTemplateId: string | undefined;
    if (parsed.data.templateId) {
      const tpl = await getChecklistTemplate(parsed.data.templateId);
      // Global templates are visible to anyone; user/craft templates must be owned by caller.
      if (!tpl || (tpl.scope !== "global" && tpl.ownerUserId !== req.auth!.userId)) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      phases = tpl.phases;
      templateLabel = tpl.name;
      resolvedTemplateId = tpl.id;
    } else if (parsed.data.phases) {
      try {
        phases = sanitizeChecklistPhases(parsed.data.phases);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
        return;
      }
    } else {
      res.status(400).json({ error: "templateId or phases required" });
      return;
    }

    const updated = await setSessionChecklistPhases(sessionId, phases);
    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const note = parsed.data.note ? ` — ${parsed.data.note}` : "";
    const announce = await appendSessionMessage(
      sessionId,
      "system",
      `[CHECKLIST] ${session.callsign ?? "Pilot"} sent checklist "${templateLabel}" (${phases.length} phases)${note}`
    );
    const sendRec = await recordChecklistSend({
      sessionId,
      messageId: announce.id,
      templateId: resolvedTemplateId,
      templateName: templateLabel,
      sentByUserId: req.auth!.userId
    });
    await logAction(req.auth!.userId, "session.checklist.send", {
      sessionId,
      templateId: parsed.data.templateId,
      phases: phases.length,
      sendId: sendRec.id
    });
    emitChecklistEvent({
      kind: "send",
      sessionId,
      at: new Date().toISOString(),
      byUserId: req.auth!.userId
    });
    emitChecklistEvent({
      kind: "state",
      sessionId,
      at: new Date().toISOString(),
      byUserId: req.auth!.userId
    });
    res.json({ ok: true, sendId: sendRec.id, ...(await checklistPayload(updated)) });
  }
);

/**
 * Controller (or any chat:session participant) acknowledges a previously-sent checklist
 * receipt. The pilot's UI surfaces the ack badge so they know the tower has it. Idempotent.
 */
apiRouter.post(
  "/session/:sessionId/checklist/ack",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const session = await loadSessionIfAuthorized(req, res, sessionId);
    if (!session) return;
    const parsed = checklistAckSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid ack payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await getChecklistSend(parsed.data.sendId);
    if (!existing || existing.sessionId !== sessionId) {
      res.status(404).json({ error: "Send not found" });
      return;
    }
    const callerId = req.auth!.userId;
    // Pilots can't ack their own send — that defeats the receipt. Allow controller for the
    // session OR any mod+. Default to controller-side semantics.
    const access = await getUserAccess(callerId);
    const isMod = roleAtLeast(access.role, "mod");
    const isControllerForSession = session.assignedTowerUserId === callerId;
    if (!isMod && !isControllerForSession) {
      res.status(403).json({ error: "Only the assigned controller can ack a checklist send" });
      return;
    }
    const updated = await ackChecklistSend(parsed.data.sendId, callerId);
    if (!updated) {
      res.status(404).json({ error: "Send not found" });
      return;
    }
    await appendSessionMessage(sessionId, "system", `[CHECKLIST] tower acknowledged "${updated.templateName}"`);
    await logAction(callerId, "session.checklist.ack", { sessionId, sendId: updated.id });
    emitChecklistEvent({
      kind: "ack",
      sessionId,
      at: new Date().toISOString(),
      byUserId: callerId
    });
    res.json({ ok: true, send: updated, ...(await checklistPayload(session)) });
  }
);

apiRouter.get(
  "/checklist/templates",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const craft = typeof req.query.craft === "string" ? req.query.craft : undefined;
    const items = await listChecklistTemplates(req.auth!.userId, craft);
    res.json({ ok: true, templates: items, defaults: DEFAULT_CHECKLIST_PHASES });
  }
);

apiRouter.post(
  "/checklist/templates",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const parsed = checklistTemplateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template payload", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.scope === "craft" && !parsed.data.craftName) {
      res.status(400).json({ error: "craftName is required for scope='craft'" });
      return;
    }
    if (parsed.data.scope === "global") {
      const access = await getUserAccess(req.auth!.userId);
      if (!roleAtLeast(access.role, "mod")) {
        res.status(403).json({ error: "scope='global' templates require mod+" });
        return;
      }
    }
    try {
      const tpl = await createChecklistTemplate(req.auth!.userId, {
        scope: parsed.data.scope,
        craftName: parsed.data.craftName,
        name: parsed.data.name,
        isDefault: parsed.data.isDefault,
        phases: sanitizeChecklistPhases(parsed.data.phases)
      });
      await logAction(req.auth!.userId, "checklist.template.create", {
        templateId: tpl.id,
        scope: tpl.scope,
        craftName: tpl.craftName
      });
      res.status(201).json({ ok: true, template: tpl });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.put(
  "/checklist/templates/:templateId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const parsed = checklistTemplatePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template payload", details: parsed.error.flatten() });
      return;
    }
    // Mod+ gate for editing globals (or moving anything into/out of global). Owner check
    // inside `updateChecklistTemplate` still applies — but for globals we want any mod to
    // be able to edit/reassign, so we pre-resolve and short-circuit the ownership check.
    const templateId = String(req.params.templateId);
    const existing = await getChecklistTemplate(templateId);
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const targetingGlobal = existing.scope === "global" || parsed.data.scope === "global";
    if (targetingGlobal) {
      const access = await getUserAccess(req.auth!.userId);
      if (!roleAtLeast(access.role, "mod")) {
        res.status(403).json({ error: "Editing scope='global' templates requires mod+" });
        return;
      }
    } else if (existing.ownerUserId !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this template" });
      return;
    }
    const patch: Partial<ChecklistTemplateInput> = {};
    if (parsed.data.scope != null) patch.scope = parsed.data.scope;
    if (parsed.data.craftName !== undefined) {
      patch.craftName = parsed.data.craftName ?? undefined;
    }
    if (parsed.data.name != null) patch.name = parsed.data.name;
    if (parsed.data.isDefault != null) patch.isDefault = parsed.data.isDefault;
    if (parsed.data.phases != null) patch.phases = sanitizeChecklistPhases(parsed.data.phases);
    try {
      // For global templates, treat the existing owner as the effective owner so the inner
      // ownership guard passes; the outer mod+ check above is the real gate.
      const effectiveOwner = existing.scope === "global" ? existing.ownerUserId : req.auth!.userId;
      const tpl = await updateChecklistTemplate(templateId, effectiveOwner, patch);
      if (!tpl) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      await logAction(req.auth!.userId, "checklist.template.update", { templateId: tpl.id });
      res.json({ ok: true, template: tpl });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }
);

apiRouter.delete(
  "/checklist/templates/:templateId",
  requireAuth,
  requireCapability("chat:session"),
  async (req, res) => {
    const templateId = String(req.params.templateId);
    const existing = await getChecklistTemplate(templateId);
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (existing.scope === "global") {
      const access = await getUserAccess(req.auth!.userId);
      if (!roleAtLeast(access.role, "mod")) {
        res.status(403).json({ error: "Deleting scope='global' templates requires mod+" });
        return;
      }
    } else if (existing.ownerUserId !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this template" });
      return;
    }
    const effectiveOwner = existing.scope === "global" ? existing.ownerUserId : req.auth!.userId;
    const ok = await deleteChecklistTemplate(templateId, effectiveOwner);
    if (!ok) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    await logAction(req.auth!.userId, "checklist.template.delete", { templateId });
    res.json({ ok: true });
  }
);
