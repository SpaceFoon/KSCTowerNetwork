export type RunwayKey = string;

export type RunwayOccupancyRecord = {
  occupied: boolean;
  bySessionId?: string;
  sinceMs?: number;
  lastLandingAtMs?: number;
  manualOverride?: boolean;
};

const occupancy = new Map<RunwayKey, RunwayOccupancyRecord>();

export function runwayKey(bodyName: string, runwayId: string): RunwayKey {
  return `${bodyName}:${runwayId.trim()}`;
}

export function getRunwayOccupancy(key: RunwayKey): RunwayOccupancyRecord | undefined {
  return occupancy.get(key);
}

export function setRunwayManualOverride(
  bodyName: string,
  runwayId: string,
  occ: { occupied: boolean; bySessionId?: string }
): void {
  const key = runwayKey(bodyName, runwayId);
  if (!occ.occupied) {
    occupancy.delete(key);
    return;
  }
  const now = Date.now();
  occupancy.set(key, {
    occupied: true,
    bySessionId: occ.bySessionId,
    sinceMs: now,
    manualOverride: true
  });
}

/** Heuristic update from live telemetry (clears manual override when sample disagrees — skip if manual). */
export function tickRunwayOccupancyFromTelemetry(input: {
  bodyName: string;
  runwayId: string;
  sessionId: string;
  radarAlt?: number;
  surfaceSpeed?: number;
  alignErr?: number;
}): void {
  const key = runwayKey(input.bodyName, input.runwayId);
  const prev = occupancy.get(key);
  if (prev?.manualOverride) return;

  const radar = input.radarAlt ?? 9999;
  const spd = input.surfaceSpeed ?? 9999;
  const align = input.alignErr ?? 999;
  const onSurface = radar < 55 && spd < 38 && align < 14;
  const now = Date.now();
  if (onSurface) {
    occupancy.set(key, {
      occupied: true,
      bySessionId: input.sessionId,
      sinceMs: prev?.bySessionId === input.sessionId ? prev.sinceMs ?? now : now,
      lastLandingAtMs: prev?.lastLandingAtMs,
      manualOverride: false
    });
  } else if (prev && prev.bySessionId === input.sessionId && (radar > 200 || spd > 55)) {
    occupancy.delete(key);
  }
}

export function markRunwayLanding(bodyName: string, runwayId: string): void {
  const key = runwayKey(bodyName, runwayId);
  const prev = occupancy.get(key);
  const now = Date.now();
  occupancy.set(key, {
    occupied: prev?.occupied ?? true,
    bySessionId: prev?.bySessionId,
    sinceMs: prev?.sinceMs ?? now,
    lastLandingAtMs: now,
    manualOverride: prev?.manualOverride
  });
}

export function snapshotAllOccupancy(): Array<{
  key: RunwayKey;
  bodyName: string;
  runwayId: string;
  record: RunwayOccupancyRecord;
}> {
  const out: Array<{ key: RunwayKey; bodyName: string; runwayId: string; record: RunwayOccupancyRecord }> = [];
  for (const [key, record] of occupancy) {
    const colon = key.indexOf(":");
    const bodyName = colon >= 0 ? key.slice(0, colon) : key;
    const runwayId = colon >= 0 ? key.slice(colon + 1) : "";
    out.push({ key, bodyName, runwayId, record });
  }
  return out;
}

export function resetRunwayOccupancyForTests(): void {
  occupancy.clear();
}
