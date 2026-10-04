/** Great-circle distance in km (WGS-style sphere with body radius). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  bodyRadiusM = 600_000
): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const φ1 = toR(lat1);
  const φ2 = toR(lat2);
  const Δφ = toR(lat2 - lat1);
  const Δλ = toR(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (bodyRadiusM * c) / 1000;
}
