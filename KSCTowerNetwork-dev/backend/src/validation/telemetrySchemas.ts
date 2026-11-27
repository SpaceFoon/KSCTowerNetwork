import { z } from "zod";

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

export const telemetrySchema = z.object({
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
export const telemetryStatusSchema = z.object({
  state: z.enum(["beacon_off", "paused", "scene_left", "warp", "vessel_dead", "vessel_switch"]),
  message: z.string().max(200).optional()
});
