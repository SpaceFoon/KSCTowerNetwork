import { publishLiveSnapshotEvent } from "../live/liveSnapshotBus";
import {
  appendSessionMessage,
  getSession,
  listSessionsMerged,
  type SessionRecord,
  type TelemetrySample
} from "../services/repository";
import { computeApproachSequences, type ApproachRow, type ApproachSequence } from "./approachQueue";
import { computeSeparationConflicts, type SeparationRow } from "./separation";
import { phaseTimelineTick } from "./phaseTimeline";
import { landingQualityFromSamples } from "./landingQuality";
import { isArrivalTouchdown, missedApproachCandidate } from "./flightEdges";
import { getRunwayOccupancy, markRunwayLanding, tickRunwayOccupancyFromTelemetry } from "./runwayState";
import { pushViolationEvent, violationDisplayLine } from "./violations";

const goAroundLast = new Map<string, number>();
const shortFinal = new Map<string, { alignErr?: number; verticalSpeed?: number }>();
const separationPairLast = new Map<string, number>();

function appendPhase(session: SessionRecord, ev: { code: string; at: string }): void {
  const list = session.phaseTimeline ?? [];
  session.phaseTimeline = [...list, ev].slice(-32);
}

function appendViolationToSession(session: SessionRecord, ev: NonNullable<ReturnType<typeof pushViolationEvent>>): void {
  const list = session.recentViolations ?? [];
  session.recentViolations = [...list, ev].slice(-16);
}

function normalizeRunwayId(s: string | undefined): string {
  return (s ?? "").trim().toUpperCase().replace(/^RWY\s*/i, "");
}

function mergeApproachRows(all: SessionRecord[]): ApproachRow[] {
  return all
    .filter((s) => s.telemetry)
    .map((s) => {
      const t = s.telemetry!;
      return {
        sessionId: s.id,
        bodyName: t.bodyName ?? "Kerbin",
        activeRunway: t.activeRunway,
        onApproach: t.onApproach,
        distKSC: t.distKSC,
        alignErr: t.alignErr,
        radarAlt: t.radarAlt,
        aslAlt: t.aslAlt,
        lat: t.lat,
        lon: t.lon
      };
    });
}

function mergeSeparationRows(all: SessionRecord[]): SeparationRow[] {
  return all
    .filter((s) => s.telemetry?.lat != null && s.telemetry?.lon != null)
    .map((s) => {
      const t = s.telemetry!;
      return {
        sessionId: s.id,
        bodyName: t.bodyName ?? "Kerbin",
        lat: t.lat,
        lon: t.lon,
        radarAlt: t.radarAlt,
        aslAlt: t.aslAlt,
        callsign: t.callsign ?? s.callsign
      };
    });
}

/**
 * Best-effort tower side-effects after a successful telemetry write. Never throws to caller.
 */
export async function runTowerTelemetryHooks(
  sessionId: string,
  prev: TelemetrySample | undefined,
  curr: TelemetrySample,
  session: SessionRecord
): Promise<{ approachSequence: ApproachSequence | null }> {
  const now = Date.now();
  let approachSequence: ApproachSequence | null = null;
  try {
    const body = curr.bodyName ?? "";
    const rw = curr.activeRunway?.trim();
    if (body && rw) {
      tickRunwayOccupancyFromTelemetry({
        bodyName: body,
        runwayId: rw,
        sessionId,
        radarAlt: curr.radarAlt,
        surfaceSpeed: curr.surfaceSpeed,
        alignErr: curr.alignErr
      });
    }

    const phaseEv = phaseTimelineTick(sessionId, curr, now);
    if (phaseEv) appendPhase(session, phaseEv);

    if (prev && missedApproachCandidate(prev, curr)) {
      const last = goAroundLast.get(sessionId) ?? 0;
      if (now - last > 50_000) {
        goAroundLast.set(sessionId, now);
        const who = session.callsign ?? curr.callsign ?? sessionId;
        await appendSessionMessage(sessionId, "system", `[GO_AROUND] Missed approach — ${who}`);
        publishLiveSnapshotEvent({ topic: "session", sessionId });
      }
    }

    if (curr.onApproach) {
      shortFinal.set(sessionId, { alignErr: curr.alignErr, verticalSpeed: curr.verticalSpeed });
    }

    const all = await listSessionsMerged();
    const seqMap = computeApproachSequences(mergeApproachRows(all));
    approachSequence = seqMap.get(sessionId) ?? null;

    const conflicts = computeSeparationConflicts(mergeSeparationRows(all));
    for (const c of conflicts) {
      const key = [c.sessionA, c.sessionB].sort().join(":");
      const last = separationPairLast.get(key) ?? 0;
      if (now - last < 30_000) continue;
      separationPairLast.set(key, now);
      for (const sid of [c.sessionA, c.sessionB]) {
        const v = pushViolationEvent(sid, "LOSS_OF_SEPARATION", now, `${c.callsignA ?? sid}/${c.callsignB}`);
        if (!v) continue;
        const sess = await getSession(sid);
        if (sess) {
          appendViolationToSession(sess, v);
          await appendSessionMessage(
            sid,
            "system",
            `${violationDisplayLine(v.kind)} (${v.detail ?? ""})`
          );
        }
      }
    }

    if (isArrivalTouchdown(prev, curr)) {
      const sf = shortFinal.get(sessionId);
      const q = landingQualityFromSamples(sf?.alignErr, sf?.verticalSpeed);
      session.lastLandingQuality = q;
      shortFinal.delete(sessionId);
      const who = session.callsign ?? curr.callsign ?? "pilot";
      await appendSessionMessage(sessionId, "system", `[LANDING] ${q.replace(/_/g, " ")} — ${who}`);

      if (body && rw) {
        const occ = getRunwayOccupancy(`${body}:${rw}`);
        if (occ?.occupied && occ.bySessionId && occ.bySessionId !== sessionId) {
          const v = pushViolationEvent(sessionId, "RWY_INCURSION", now, occ.bySessionId);
          if (v) {
            appendViolationToSession(session, v);
            await appendSessionMessage(sessionId, "system", `${violationDisplayLine(v.kind)} (${who})`);
          }
        }
        markRunwayLanding(body, rw);
      }

      if (session.clearances?.LANDING !== "cleared") {
        const v = pushViolationEvent(sessionId, "LANDING_NO_CLEARANCE", now);
        if (v) {
          appendViolationToSession(session, v);
          await appendSessionMessage(sessionId, "system", `${violationDisplayLine(v.kind)} (${who})`);
        }
      }

      const expected = session.expectedLandingRunway?.trim();
      if (expected && rw) {
        if (normalizeRunwayId(rw) !== normalizeRunwayId(expected)) {
          const v = pushViolationEvent(sessionId, "WRONG_RUNWAY", now, `${rw}≠${expected}`);
          if (v) {
            appendViolationToSession(session, v);
            await appendSessionMessage(sessionId, "system", `${violationDisplayLine(v.kind)} (${who})`);
          }
        }
      }

      publishLiveSnapshotEvent({ topic: "session", sessionId });
      publishLiveSnapshotEvent({ topic: "active-aircraft" });
    }
  } catch {
    // swallow — never break telemetry
  }
  return { approachSequence };
}
