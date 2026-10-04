import { haversineKm } from "./geo";

export type ApproachRow = {
  sessionId: string;
  bodyName: string;
  activeRunway?: string;
  onApproach?: boolean;
  distKSC?: number;
  alignErr?: number;
  radarAlt?: number;
  aslAlt?: number;
  lat?: number;
  lon?: number;
};

export type ApproachSequence = { index: number; of: number; gapKmBehindLeader?: number };

/** Per-sessionId approach ordering for same body + active runway, `onApproach` only. */
export function computeApproachSequences(rows: ApproachRow[]): Map<string, ApproachSequence> {
  const groups = new Map<string, ApproachRow[]>();
  for (const r of rows) {
    if (!r.onApproach || !r.activeRunway?.trim()) continue;
    const key = `${r.bodyName}:${r.activeRunway.trim()}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, ApproachSequence>();
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => {
      const da = a.distKSC ?? Number.POSITIVE_INFINITY;
      const db = b.distKSC ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      const aa = a.alignErr ?? 999;
      const ab = b.alignErr ?? 999;
      if (aa !== ab) return aa - ab;
      const ra = a.radarAlt ?? a.aslAlt ?? Number.POSITIVE_INFINITY;
      const rb = b.radarAlt ?? b.aslAlt ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return rb - ra;
      return a.sessionId.localeCompare(b.sessionId);
    });
    sorted.forEach((r, i) => {
      let gapKm: number | undefined;
      if (i > 0) {
        const prevRow = sorted[i - 1];
        if (
          prevRow &&
          prevRow.lat != null &&
          prevRow.lon != null &&
          r.lat != null &&
          r.lon != null &&
          Number.isFinite(prevRow.lat) &&
          Number.isFinite(prevRow.lon) &&
          Number.isFinite(r.lat) &&
          Number.isFinite(r.lon)
        ) {
          gapKm = haversineKm(prevRow.lat, prevRow.lon, r.lat, r.lon);
        }
      }
      out.set(r.sessionId, { index: i + 1, of: sorted.length, gapKmBehindLeader: gapKm });
    });
  }
  return out;
}
