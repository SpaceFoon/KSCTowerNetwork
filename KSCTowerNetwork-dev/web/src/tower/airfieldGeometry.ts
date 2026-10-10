import { KERBIN_NAVAIDS } from "../data/kerbinNavaids";

export const KERBIN_RADIUS_M = 600000;
const ksc = KERBIN_NAVAIDS.find((n) => n.id === "KST");
export const KSC_LAT = ksc?.lat ?? -0.06301651539;
export const KSC_LON = ksc?.lon ?? -74.63320905499;

export function kerbinDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number, radiusM = KERBIN_RADIUS_M): number {
  const d2r = Math.PI / 180;
  const dp = (lat2 - lat1) * d2r;
  const dl = (lon2 - lon1) * d2r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dl / 2) ** 2;
  const bounded = Math.max(0, Math.min(1, a));
  return 2 * radiusM * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}
