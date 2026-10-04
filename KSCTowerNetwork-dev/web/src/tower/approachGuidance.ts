import { KKSC_ILS_GEOMETRY, type KerbinAerodromeRunway } from "../data/kerbinAeroCharts";

const DEFAULT_BODY_RADIUS_M = 600000;

/** Smallest absolute difference between two compass headings (degrees), range [0, 180]. */
export function headingDiffDeg(a: number, b: number): number {
  const x = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(x, 360 - x);
}

export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusM: number = DEFAULT_BODY_RADIUS_M
): number {
  const d2r = Math.PI / 180;
  const p1 = lat1 * d2r;
  const p2 = lat2 * d2r;
  const dp = (lat2 - lat1) * d2r;
  let dl = (lon2 - lon1) * d2r;
  while (dl > Math.PI) dl -= 2 * Math.PI;
  while (dl < -Math.PI) dl += 2 * Math.PI;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Local tangent plane meters: x east, y north, origin at refLat/refLon.
 * Accurate enough for runway-scale geometry on Kerbin-sized bodies.
 */
export function latLonToEnM(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number,
  radiusM: number
): { x: number; y: number } {
  const d2r = Math.PI / 180;
  const x = (lon - refLon) * d2r * Math.cos(refLat * d2r) * radiusM;
  const y = (lat - refLat) * d2r * radiusM;
  return { x, y };
}

export type TowerApproachLabels = {
  onApproach: boolean;
  align: "GOOD" | "BAD";
  glide: "HIGH" | "LOW" | "GOOD";
  /** Signed perpendicular distance to extended centerline (m); + = to the right of inbound direction. */
  lateralOffsetM: number;
  /**
   * Distance from threshold along the extended final toward the aircraft (m).
   * Positive when the aircraft is on the approach side of the threshold.
   */
  alongApproachM: number;
  runwayDesignator: "09" | "27";
  runwayHeadingDeg: number;
  headingErrorDeg: number;
};

export type TowerGuidanceNumbers = {
  kscDistanceKm: number | null;
} & TowerApproachLabels;

function pickRunwayForKksc(
  headingDeg: number | null | undefined,
  runways: readonly KerbinAerodromeRunway[]
): KerbinAerodromeRunway {
  const r09 = runways.find((r) => r.designator === "09") ?? runways[0]!;
  const r27 = runways.find((r) => r.designator === "27") ?? runways[1]!;
  if (headingDeg == null || !Number.isFinite(headingDeg)) return r09;
  const e09 = headingDiffDeg(headingDeg, r09.headingDeg);
  const e27 = headingDiffDeg(headingDeg, r27.headingDeg);
  return e27 < e09 ? r27 : r09;
}

/**
 * Inbound unit vector (east, north) from the far end of the runway toward `thr` (final direction).
 */
function inboundUnitEn(
  thr: KerbinAerodromeRunway,
  other: KerbinAerodromeRunway,
  radiusM: number
): { x: number; y: number } {
  const t = latLonToEnM(thr.thresholdLat, thr.thresholdLon, thr.thresholdLat, thr.thresholdLon, radiusM);
  const o = latLonToEnM(other.thresholdLat, other.thresholdLon, thr.thresholdLat, thr.thresholdLon, radiusM);
  const vx = t.x - o.x;
  const vy = t.y - o.y;
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

function bearingFromUnitEn(ux: number, uy: number): number {
  return ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360;
}

/**
 * KKSC-only tower guidance: simple on-approach gate, lateral alignment, and 3° glide hint.
 */
export function computeKkscTowerGuidance(
  input: {
    lat: number;
    lon: number;
    headingDeg?: number | null;
    radarAltM?: number | null;
    aslAltM?: number | null;
    runwayPair: readonly KerbinAerodromeRunway[];
    kscLat: number;
    kscLon: number;
    bodyRadiusM?: number;
  }
): TowerGuidanceNumbers {
  const R = input.bodyRadiusM ?? DEFAULT_BODY_RADIUS_M;
  const kscDistanceKm =
    Number.isFinite(input.lat) && Number.isFinite(input.lon)
      ? haversineDistanceM(input.lat, input.lon, input.kscLat, input.kscLon, R) / 1000
      : null;

  const r09 = input.runwayPair.find((r) => r.designator === "09") ?? input.runwayPair[0]!;
  const r27 = input.runwayPair.find((r) => r.designator === "27") ?? input.runwayPair[1]!;
  const thr = pickRunwayForKksc(input.headingDeg, [r09, r27]);
  const other = thr.designator === "09" ? r27 : r09;

  const inbound = inboundUnitEn(thr, other, R);
  const p = latLonToEnM(input.lat, input.lon, thr.thresholdLat, thr.thresholdLon, R);
  const signedAlongInbound = p.x * inbound.x + p.y * inbound.y;
  /** Positive when the aircraft sits on the approach side of the threshold along the final axis. */
  const alongApproachM = -signedAlongInbound;
  const lateralOffsetM = p.x * inbound.y - p.y * inbound.x;

  const landingBearing = bearingFromUnitEn(inbound.x, inbound.y);
  const heading = input.headingDeg != null && Number.isFinite(input.headingDeg) ? input.headingDeg : landingBearing;
  const headingErrorDeg = headingDiffDeg(heading, landingBearing);

  const altM =
    input.radarAltM != null && Number.isFinite(input.radarAltM)
      ? input.radarAltM
      : input.aslAltM != null && Number.isFinite(input.aslAltM)
        ? input.aslAltM - thr.thresholdElevationM
        : null;

  const ON_APP_MAX_ALONG_M = 30_000;
  const ON_APP_MAX_ALT_M = 3000;
  const ON_APP_MAX_HEADING_ERR = 20;
  const lateralLimitM = Math.max(500, alongApproachM * Math.tan((ON_APP_MAX_HEADING_ERR * Math.PI) / 180));

  const onApproach =
    altM != null &&
    altM < ON_APP_MAX_ALT_M &&
    alongApproachM > 0 &&
    alongApproachM < ON_APP_MAX_ALONG_M &&
    headingErrorDeg < ON_APP_MAX_HEADING_ERR &&
    Math.abs(lateralOffsetM) < lateralLimitM;

  const ALIGN_GOOD_M = 120;
  const align: "GOOD" | "BAD" = Math.abs(lateralOffsetM) <= ALIGN_GOOD_M ? "GOOD" : "BAD";

  const glidePathRad = (KKSC_ILS_GEOMETRY.glidePathDeg * Math.PI) / 180;
  let glide: "HIGH" | "LOW" | "GOOD" = "GOOD";
  if (altM != null && alongApproachM > 250) {
    const expectedAgl = alongApproachM * Math.tan(glidePathRad);
    const bandM = Math.max(40, expectedAgl * 0.15);
    if (altM > expectedAgl + bandM) glide = "HIGH";
    else if (altM < expectedAgl - bandM) glide = "LOW";
  }

  return {
    kscDistanceKm,
    onApproach,
    align,
    glide,
    lateralOffsetM,
    alongApproachM,
    runwayDesignator: thr.designator,
    runwayHeadingDeg: thr.headingDeg,
    headingErrorDeg
  };
}
