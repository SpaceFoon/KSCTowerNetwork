/**
 * ILS outer/middle/inner marker positions derived from runway thresholds and
 * published along-track distances (meters before touchdown). No bundled chart
 * coordinates — geometry only.
 */
import { KERBIN_AERODROMES, type KerbinIlsMarker } from "./kerbinAeroCharts";

const KERBIN_RADIUS_M = 600_000;

function offsetLatLonMeters(
  lat: number,
  lon: number,
  bearingTrueDeg: number,
  distM: number,
  bodyRadiusM: number
): { lat: number; lon: number } {
  const distKm = distM / 1000;
  const bodyRadiusKm = bodyRadiusM / 1000;
  const angDeg = (distKm / Math.max(1, bodyRadiusKm)) * (180 / Math.PI);
  const bearingRad = (bearingTrueDeg * Math.PI) / 180;
  const dLat = angDeg * Math.cos(bearingRad);
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dLon = (angDeg * Math.sin(bearingRad)) / cosLat;
  return { lat: lat + dLat, lon: lon + dLon };
}

/** True bearing from threshold back along final approach (toward OM). */
function outboundFinalBearing(headingDeg: number): number {
  return ((headingDeg + 180) % 360 + 360) % 360;
}

type MarkerLeg = {
  id: string;
  aerodrome: KerbinIlsMarker["aerodrome"];
  runway: KerbinIlsMarker["runway"];
  position: KerbinIlsMarker["position"];
  tdzDistanceM: number;
  dmeCallout?: string;
  note?: string;
};

const LEGS: readonly MarkerLeg[] = [
  {
    id: "KKSC-09-OM",
    aerodrome: "KKSC",
    runway: "09",
    position: "OM",
    tdzDistanceM: 8300,
    dmeCallout: "D8.3 IKW"
  },
  {
    id: "KKSC-09-MM",
    aerodrome: "KKSC",
    runway: "09",
    position: "MM",
    tdzDistanceM: 1300,
    dmeCallout: "D4.3 IKW"
  },
  {
    id: "KKSC-09-IM",
    aerodrome: "KKSC",
    runway: "09",
    position: "IM",
    tdzDistanceM: 500,
    dmeCallout: "D0.5 IKW"
  },
  {
    id: "KKSC-27-MM",
    aerodrome: "KKSC",
    runway: "27",
    position: "MM",
    tdzDistanceM: 1100,
    dmeCallout: "D1.1 IWE"
  },
  {
    id: "KKSC-27-IM",
    aerodrome: "KKSC",
    runway: "27",
    position: "IM",
    tdzDistanceM: 500,
    dmeCallout: "D0.5 IWE"
  },
  {
    id: "KAFD-09-IM",
    aerodrome: "KAFD",
    runway: "09",
    position: "IM",
    tdzDistanceM: 146
  },
  {
    id: "KAFD-27-IM",
    aerodrome: "KAFD",
    runway: "27",
    position: "IM",
    tdzDistanceM: 155
  }
];

/**
 * Builds ILS marker lat/lon from `KERBIN_AERODROMES` runway headings/thresholds.
 * @param bodyRadiusM celestial radius in meters (stock Kerbin 600_000).
 */
export function buildKerbinIlsMarkers(bodyRadiusM: number = KERBIN_RADIUS_M): KerbinIlsMarker[] {
  const out: KerbinIlsMarker[] = [];
  for (const leg of LEGS) {
    const aero = KERBIN_AERODROMES.find((a) => a.id === leg.aerodrome);
    if (!aero) continue;
    const rwy = aero.runways.find((r) => r.designator === leg.runway);
    if (!rwy) continue;
    const brg = outboundFinalBearing(rwy.headingDeg);
    const { lat, lon } = offsetLatLonMeters(
      rwy.thresholdLat,
      rwy.thresholdLon,
      brg,
      leg.tdzDistanceM,
      bodyRadiusM
    );
    out.push({
      id: leg.id,
      aerodrome: leg.aerodrome,
      runway: leg.runway,
      position: leg.position,
      lat,
      lon,
      elevationM: rwy.thresholdElevationM,
      tdzDistanceM: leg.tdzDistanceM,
      dmeCallout: leg.dmeCallout,
      note: leg.note
    });
  }
  return out;
}
