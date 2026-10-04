import { queryKeys } from "../query/client";
import { useApiQuery } from "../query/hooks";
import type { SessionEvent } from "../session/Scorecard";

type Profile = {
  userId: string;
  rep: number;
  achievements: number;
  penalties: number;
  recent: SessionEvent[];
};

type ProfileResponse = { ok: boolean; profile: Profile };

type Props = {
  userId: string;
  onClose: () => void;
};

/**
 * Lightweight modal-style overlay for a pilot/controller's lifetime stats. Opened from any
 * `userId` chip in the lobby/scorecard. The backend `/users/:id/profile` endpoint returns
 * the cached `users.rep/achievements/penalties` plus the most recent 20 events.
 */
export function PilotProfile({ userId, onClose }: Props): JSX.Element {
  // One-shot fetch keyed by userId. Cached so re-opening the same profile
  // within `staleTime` is instant; otherwise refetched in background.
  const profileQuery = useApiQuery<ProfileResponse>({
    queryKey: queryKeys.pilot.profile(userId),
    path: `/v1/users/${encodeURIComponent(userId)}/profile`,
    staleTime: 30_000
  });
  const profile: Profile | null = profileQuery.data?.profile ?? null;
  const loading = profileQuery.isLoading;
  const error = profileQuery.error
    ? profileQuery.error.unreachable
      ? "API unreachable"
      : profileQuery.error.message
    : null;

  return (
    <div className="pilot-profile-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pilot-profile-card" onClick={(e) => e.stopPropagation()}>
        <header className="pilot-profile-head">
          <div>
            <h2>Pilot profile</h2>
            <code className="pilot-profile-id">{userId}</code>
          </div>
          <button type="button" onClick={onClose} aria-label="Close profile">
            ✕
          </button>
        </header>

        {loading ? <p className="room-meta">Loading…</p> : null}
        {error ? <pre className="msg error">{error}</pre> : null}

        {profile ? (
          <>
            <div className="pilot-profile-stats">
              <Stat label="Reputation" value={profile.rep} positive={profile.rep >= 0} />
              <Stat label="Achievements" value={profile.achievements} positive />
              <Stat label="Penalties" value={profile.penalties} positive={false} />
            </div>
            <h3>Recent events</h3>
            {profile.recent.length === 0 ? (
              <p className="room-meta">No events yet.</p>
            ) : (
              <ul className="pilot-profile-feed">
                {profile.recent.map((ev) => (
                  <li key={ev.id} className={"pilot-profile-row src-" + ev.source}>
                    <span className="atc-scorecard-time">
                      {new Date(ev.createdAt).toLocaleString()}
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
                    <span className="atc-scorecard-label">
                      [{ev.kind.toUpperCase()}] {ev.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: number; positive: boolean }): JSX.Element {
  return (
    <div className={"pilot-profile-stat " + (positive ? "good" : "bad")}>
      <div className="pilot-profile-stat-label">{label}</div>
      <div className="pilot-profile-stat-value">{value}</div>
    </div>
  );
}
