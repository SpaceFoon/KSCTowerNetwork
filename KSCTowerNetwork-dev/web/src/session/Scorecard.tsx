import { useState } from "react";
import type { AuthUser } from "../auth/session";
import { userHasCapability } from "../auth/session";
import { queryKeys } from "../query/client";
import { apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";

export type SessionEvent = {
  id: string;
  sessionId: string;
  targetUserId: string;
  actorUserId?: string;
  kind: string;
  points: number;
  label: string;
  source: "auto" | "controller" | "client_preview";
  createdAt: string;
};

export type ScorecardTotals = {
  userId: string;
  rep: number;
  achievements: number;
  penalties: number;
};

type ScorecardResponse = {
  ok: boolean;
  sessionId: string;
  events: SessionEvent[];
  totals: ScorecardTotals[];
};

type Props = {
  sessionId: string;
  user: AuthUser;
  /** Pilot user id for this session — default `targetUserId` for controller manual events. */
  pilotUserId?: string;
  /** Open a profile card; if not provided we no-op. */
  onOpenProfile?: (userId: string) => void;
};

const QUICK_BUTTONS: Array<{
  kind: string;
  label: string;
  points: number;
  className: string;
}> = [
  { kind: "pro_comms", label: "+5 Pro comms", points: 5, className: "score-good" },
  { kind: "hot_mic", label: "-5 Hot mic", points: -5, className: "score-bad" },
  { kind: "ignored_atc", label: "-10 Ignored ATC", points: -10, className: "score-bad" }
];

const SCORECARD_POLL_MS = 2_500;

export function Scorecard({ sessionId, user, pilotUserId, onOpenProfile }: Props): JSX.Element {
  const isController = userHasCapability(user, "controller:assume");
  const qc = useQueryClient();

  const q = useApiQuery<ScorecardResponse>({
    queryKey: queryKeys.session.scorecard(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/scorecard`,
    enabled: !!sessionId,
    refetchInterval: sessionId ? SCORECARD_POLL_MS : false,
    placeholderData: (prev) => prev
  });
  const data = q.data ?? null;

  const awardMutation = useApiMutation<
    unknown,
    { kind: string; label: string; points: number }
  >({
    mutationFn: (vars) => {
      if (!pilotUserId) {
        return Promise.reject(new Error("No pilot to award"));
      }
      return apiCall(`/v1/session/${encodeURIComponent(sessionId)}/score`, {
        method: "POST",
        body: JSON.stringify({
          targetUserId: pilotUserId,
          kind: vars.kind,
          points: vars.points,
          label: vars.label
        })
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.session.scorecard(sessionId) })
  });

  const [pendingKind, setPendingKind] = useState<string | null>(null);
  function award(kind: string, label: string, points: number): void {
    setPendingKind(kind);
    awardMutation.mutate(
      { kind, label, points },
      { onSettled: () => setPendingKind(null) }
    );
  }

  const error = awardMutation.error?.message ?? null;

  return (
    <section className="atc-panel atc-scorecard">
      <div className="atc-panel-head">
        <h3>Scorecard</h3>
        {isController ? (
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
            {QUICK_BUTTONS.map((b) => (
              <button
                key={b.kind}
                type="button"
                className={"score-quick-btn " + b.className}
                disabled={pendingKind === b.kind || !pilotUserId}
                onClick={() => award(b.kind, b.label, b.points)}
              >
                {b.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <pre className="msg error">{error}</pre> : null}

      <div className="atc-scorecard-totals">
        {data?.totals.length ? (
          data.totals.map((t) => (
            <button
              key={t.userId}
              type="button"
              className="atc-scorecard-total-pill"
              onClick={() => onOpenProfile?.(t.userId)}
              title={`${t.achievements} achievements / ${t.penalties} penalties`}
            >
              <span className="atc-scorecard-name">{t.userId}</span>
              <span className={"atc-scorecard-rep " + (t.rep >= 0 ? "good" : "bad")}>
                {t.rep >= 0 ? "+" : ""}
                {t.rep}
              </span>
            </button>
          ))
        ) : (
          <p className="room-meta">No score yet.</p>
        )}
      </div>

      <ul className="atc-scorecard-feed">
        {data?.events.length ? (
          data.events.map((ev) => (
            <li key={ev.id} className={"atc-scorecard-row src-" + ev.source}>
              <span className="atc-scorecard-time">
                {new Date(ev.createdAt).toLocaleTimeString()}
              </span>
              <span
                className={
                  "atc-scorecard-pts " +
                  (ev.points > 0 ? "good" : ev.points < 0 ? "bad" : "neutral")
                }
              >
                {ev.points >= 0 ? "+" : ""}
                {ev.points}
              </span>
              <span className="atc-scorecard-label">[{ev.kind.toUpperCase()}] {ev.label}</span>
              <button
                type="button"
                className="atc-scorecard-target"
                onClick={() => onOpenProfile?.(ev.targetUserId)}
              >
                {ev.targetUserId}
              </button>
            </li>
          ))
        ) : (
          <li className="room-meta">No events yet.</li>
        )}
      </ul>
    </section>
  );
}
