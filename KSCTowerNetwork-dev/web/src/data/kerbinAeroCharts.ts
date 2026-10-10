/**
 * Kerbin aviation supplement data (reception ranges, morse + antenna heights,
 * aerodrome reference points / runway thresholds, tower / approach / ATIS
 * frequencies) keyed to the same beacon / site IDs as `MAS_NavAid.cfg` (mirrored
 * in `kerbinNavaids.ts`). The full source PDF, all 22 page images, searchable
 * transcripts, and printed source rows are optional local chart installations.
 * Those reference assets retain CC BY-NC-SA 3.0; see the root NOTICE.md.
 *
 * Navaid lat/lon still comes from MAS; this module holds fields MAS does not
 * publish. Where published reference coords disagree with MAS by more than a small
 * margin we trust MAS and record it in per-id notes.
 */
import type { KerbinNavAidKind } from "./kerbinNavaids";

/**
 * Page 2-1 (NAVAIDS OVERVIEW) prints a small table of "approx range" rings for
 * each beacon class at two reference altitudes. Treat these as line-of-sight /
 * published service-volume distances; for any altitude in between, interpolate
 * (or, more accurately, extrapolate from the geometric horizon — the chart
 * numbers track `~3.57 * sqrt(h_m)` km within a few percent).
 */
export type KerbinNavAidClassRange = {
  kind: KerbinNavAidKind | "DME";
  /** Range in km when the receiving aircraft is at 5 000 m ASL. */
  rangeKmAt5000m: number;
  /** Range in km when the receiving aircraft is at 10 000 m ASL. */
  rangeKmAt10000m: number;
};

export const KERBIN_NAVAID_CLASS_RANGES: KerbinNavAidClassRange[] = [
  { kind: "VOR", rangeKmAt5000m: 186, rangeKmAt10000m: 263 },
  { kind: "DME", rangeKmAt5000m: 217, rangeKmAt10000m: 306 },
  { kind: "NDB", rangeKmAt5000m: 155, rangeKmAt10000m: 263 },
  // ILS LOC/GP isn't given a chart-wide range; usable signal is only inside
  // the published procedure (≈ D25 IKW / D10 IWE on the KKSC plates).
  { kind: "ILS", rangeKmAt5000m: 46, rangeKmAt10000m: 46 },
];

/**
 * Estimate VOR/DME/NDB reception range (km) at an arbitrary receiver altitude.
 * Anchors to the chart values at 5 000 m and 10 000 m and falls back to the
 * line-of-sight horizon (`3.57 * sqrt(h_m)`) outside that band so the curve
 * stays monotonic at sea level and at orbital altitudes.
 */
export function approxNavaidRangeKm(kind: KerbinNavAidKind, altitudeM: number): number {
  const row = KERBIN_NAVAID_CLASS_RANGES.find((r) => r.kind === kind);
  if (!row) return 0;
  const h = Math.max(0, altitudeM);
  const losKm = 3.57 * Math.sqrt(h);
  if (h <= 5000) {
    return Math.min(row.rangeKmAt5000m, losKm + (row.rangeKmAt5000m - 3.57 * Math.sqrt(5000)) * (h / 5000));
  }
  if (h <= 10000) {
    const t = (h - 5000) / 5000;
    return row.rangeKmAt5000m + t * (row.rangeKmAt10000m - row.rangeKmAt5000m);
  }
  // Above 10 km: scale with the horizon ratio so the chart numbers extend to
  // jet / sub-orbital altitudes without going flat.
  return row.rangeKmAt10000m * (losKm / (3.57 * Math.sqrt(10000)));
}

/**
 * Per-id supplement to `KERBIN_NAVAIDS`. Only fields that the chart adds on top
 * of MAS_NavAid.cfg are listed; lat/lon stays in `kerbinNavaids.ts`.
 */
export type KerbinNavAidChartDetail = {
  id: string;
  /**
   * Morse pattern of the ID, dot = "·", dash = "−", space = letter break.
   * `null` for chart rows where the author copied a placeholder pattern (most
   * NAME 04..NAME 20 entries reuse the "KST" morse and aren't real).
   */
  morse: string | null;
  /** Antenna elevation in meters ASL, as printed in the ALTITUDE column. */
  antennaElevationM: number;
  /**
   * Service-volume class as drawn on pages 4-1..4-3 (`(H)` next to the navaid
   * box). The chart only annotates the KSC-sector beacons; everything else is
   * left unclassified and we default to `H` for VOR/DME and `MH` for NDB,
   * matching the standard ICAO assumption for an unmarked en-route beacon.
   */
  classCode: "T" | "L" | "H" | "MH" | "HH";
  /** Free-text caveat (e.g. chart vs MAS coord mismatch) for the data inspector. */
  note?: string;
};

export const KERBIN_NAVAID_CHART_DETAILS: KerbinNavAidChartDetail[] = [
  { id: "KST", morse: "−·− ··· −", antennaElevationM: 160, classCode: "H" },
  { id: "IFT", morse: "·· ·−· ·−−", antennaElevationM: 181.9, classCode: "H" },
  { id: "ESI", morse: "· ··· ··", antennaElevationM: 1442, classCode: "H" },
  { id: "ID04", morse: null, antennaElevationM: 414, classCode: "H" },
  { id: "Id05", morse: null, antennaElevationM: 375, classCode: "H" },
  { id: "Id06", morse: null, antennaElevationM: 770, classCode: "H" },
  { id: "Id07", morse: null, antennaElevationM: 1462, classCode: "H" },
  { id: "Id08", morse: null, antennaElevationM: 273, classCode: "H" },
  { id: "Id09", morse: null, antennaElevationM: 760, classCode: "H" },
  { id: "Id10", morse: null, antennaElevationM: 825, classCode: "H" },
  { id: "Id11", morse: null, antennaElevationM: 2136, classCode: "H" },
  { id: "Id12", morse: null, antennaElevationM: 1323, classCode: "H" },
  { id: "Id13", morse: null, antennaElevationM: 889, classCode: "H" },
  { id: "Id14", morse: null, antennaElevationM: 1137, classCode: "H" },
  { id: "Id15", morse: null, antennaElevationM: 632, classCode: "H" },
  { id: "Id16", morse: null, antennaElevationM: 359, classCode: "H" },
  {
    id: "Id17",
    morse: null,
    antennaElevationM: 596,
    classCode: "H",
    note: "Chart prints 36°45'37\"S 139°21'54\"E; MAS_NavAid.cfg places it 10° further south at -46.76. We trust MAS for in-game position.",
  },
  { id: "Id18", morse: null, antennaElevationM: 665, classCode: "H" },
  { id: "Id19", morse: null, antennaElevationM: 999, classCode: "H" },
  { id: "Id20", morse: null, antennaElevationM: 798, classCode: "H" },
  { id: "SCE", morse: "··· −·− ·", antennaElevationM: 745, classCode: "MH" },
  { id: "IRW", morse: "·· ·−· ·−−", antennaElevationM: 83.4, classCode: "MH" },
  { id: "IRE", morse: "·· ·−· ·", antennaElevationM: 97.8, classCode: "MH" },
  {
    id: "Id03",
    morse: null,
    antennaElevationM: 1039,
    classCode: "MH",
    note: "Chart prints 20°41'54\"N; MAS_NavAid.cfg has the same magnitude in the southern hemisphere (-20.698). MAS wins.",
  },
  { id: "Id04", morse: null, antennaElevationM: 228, classCode: "MH" },
  { id: "Id05", morse: null, antennaElevationM: 2208, classCode: "MH" },
  { id: "Id06", morse: null, antennaElevationM: 530, classCode: "MH" },
  { id: "Id07", morse: null, antennaElevationM: 518, classCode: "MH" },
  { id: "Id08", morse: null, antennaElevationM: 605, classCode: "MH" },
  { id: "Id09", morse: null, antennaElevationM: 476, classCode: "MH" },
  { id: "Id10", morse: null, antennaElevationM: 514, classCode: "MH" },
  { id: "Id11", morse: null, antennaElevationM: 340, classCode: "MH" },
  { id: "Id12", morse: null, antennaElevationM: 747, classCode: "MH" },
  { id: "IKW", morse: "·· −·− ·−−", antennaElevationM: 70, classCode: "T" },
  { id: "IWE", morse: "·· ·−− ·", antennaElevationM: 70, classCode: "T" },
];

/** ILS outer/middle/inner marker beacons (lat/lon from runway geometry; see `kerbinIlsMarkersComputed.ts`). */
export type KerbinIlsMarker = {
  /** Stable id, e.g. `KKSC-09-OM`. */
  id: string;
  aerodrome: "KKSC" | "KAFD";
  runway: "09" | "27";
  position: "OM" | "MM" | "IM";
  lat: number;
  lon: number;
  /** Antenna elevation in meters ASL. */
  elevationM: number;
  /** Distance to the touchdown zone, in meters, as printed in the TDZ column. */
  tdzDistanceM: number;
  /** DME callout from page 4-1 (`D8.3 IKW`, `D0.5 IWE`, ...) when present. */
  dmeCallout?: string;
  note?: string;
};

/** Aerodrome reference + runway thresholds (game-surveyed / MAS-aligned). */
export type KerbinAerodromeRunway = {
  designator: "09" | "27";
  /** Magnetic heading printed on the chart (degrees, fractional). */
  headingDeg: number;
  thresholdLat: number;
  thresholdLon: number;
  /** Threshold elevation in meters ASL. */
  thresholdElevationM: number;
};

export type KerbinAerodrome = {
  id: "KKSC" | "KAFD";
  name: string;
  /** Aerodrome reference point (the chart's "ELEV" datum). */
  refLat: number;
  refLon: number;
  refElevationM: number;
  /** Runway length × width × surface, e.g. "2500 x 60 CONCRETE". */
  runwaySpec: string;
  runways: KerbinAerodromeRunway[];
};

export const KERBIN_AERODROMES: KerbinAerodrome[] = [
  {
    id: "KKSC",
    name: "Kerbal Space Center",
    refLat: -0.05,
    refLon: -74.6075,
    refElevationM: 69.1,
    runwaySpec: "2500 x 60 CONCRETE",
    runways: [
      {
        designator: "09",
        headingDeg: 89.85,
        thresholdLat: -0.050278,
        thresholdLon: -74.488611,
        thresholdElevationM: 69.2,
      },
      {
        designator: "27",
        headingDeg: 270.15,
        thresholdLat: -0.048611,
        thresholdLon: -74.728333,
        thresholdElevationM: 68.9,
      },
    ],
  },
  {
    id: "KAFD",
    name: "Island Airfield",
    refLat: -1.5175,
    refLon: -71.911111,
    refElevationM: 133.7,
    runwaySpec: "1200 CLAY/GRASS",
    runways: [
      {
        designator: "09",
        headingDeg: 90.0,
        thresholdLat: -1.516111,
        thresholdLon: -71.967222,
        thresholdElevationM: 133.7,
      },
      {
        designator: "27",
        headingDeg: 270.0,
        thresholdLat: -1.516111,
        thresholdLon: -71.855278,
        thresholdElevationM: 133.7,
      },
    ],
  },
];

/** ATC voice frequencies advertised on the KKSC + KAFD ILS plates (MHz, AM voice). */
export type KerbinAerodromeFrequencies = {
  aerodrome: "KKSC" | "KAFD";
  approachMHz: number;
  towerMHz: number;
  groundMHz: number;
  atisMHz: number;
};

export const KERBIN_AERODROME_FREQUENCIES: KerbinAerodromeFrequencies[] = [
  { aerodrome: "KKSC", approachMHz: 127.5, towerMHz: 122.0, groundMHz: 121.7, atisMHz: 131.3 },
  // KAFD: only TWR/GND are canonically distinct for the island strip; APP/ATIS mirror KKSC
  // as the published default since both fields share the same KSC sector controller.
  { aerodrome: "KAFD", approachMHz: 127.5, towerMHz: 122.0, groundMHz: 121.7, atisMHz: 131.3 },
];

/**
 * KKSC ILS glide-path geometry (3.00° GP, 15 m TCH, DA/H 95 m / 26 m, MDA 250 m for the
 * non-precision missed-approach abort), shared by both runways. Exposed as a constant so
 * cockpit instrument/HUD code can render the diamond bug without duplicating numbers.
 */
export const KKSC_ILS_GEOMETRY = {
  glidePathDeg: 3.0,
  thresholdCrossingHeightM: 15,
  decisionAltitudeM: 95,
  decisionHeightM: 26,
  missedApproachClimbToM: 1500,
  /** Distance from the runway threshold at which the missed-approach turn is initiated. */
  missedApproachTurnDmeKm: 5.0,
} as const;
