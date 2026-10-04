import { haversineKm } from "./geo";

export type SeparationConflict = {
  sessionA: string;
  sessionB: string;
  callsignA?: string;
  callsignB?: string;
};

export type SeparationRow = {
  sessionId: string;
  bodyName: string;
  lat?: number;
  lon?: number;
  radarAlt?: number;
  aslAlt?: number;
  callsign?: string;
};

const HORIZ_KM = 2;
const VERT_M = 300;

export function computeSeparationConflicts(rows: SeparationRow[], bodyRadiusM = 600_000): SeparationConflict[] {
  const out: SeparationConflict[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) continue;
      if (a.bodyName !== b.bodyName) continue;
      if (
        a.lat == null ||
        a.lon == null ||
        b.lat == null ||
        b.lon == null ||
        !Number.isFinite(a.lat) ||
        !Number.isFinite(a.lon) ||
        !Number.isFinite(b.lat) ||
        !Number.isFinite(b.lon)
      ) {
        continue;
      }
      const h = haversineKm(a.lat, a.lon, b.lat, b.lon, bodyRadiusM);
      if (h >= HORIZ_KM) continue;
      const altA = a.radarAlt ?? a.aslAlt ?? 0;
      const altB = b.radarAlt ?? b.aslAlt ?? 0;
      if (!Number.isFinite(altA) || !Number.isFinite(altB)) continue;
      if (Math.abs(altA - altB) >= VERT_M) continue;
      out.push({
        sessionA: a.sessionId,
        sessionB: b.sessionId,
        callsignA: a.callsign,
        callsignB: b.callsign
      });
    }
  }
  return out;
}
