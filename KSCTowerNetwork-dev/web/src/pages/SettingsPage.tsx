import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AuthUser } from "../auth/session";
import { authUserFromResponse, setStoredUser } from "../auth/session";
import { queryKeys } from "../query/client";
import { ApiError, apiCall, useApiQuery, useQueryClient } from "../query/hooks";
import {
  getVoiceTopBarPtt,
  getVoiceTopBarSnapshot,
  subscribeVoiceTopBar
} from "../voice/sessionVoiceTopBarBridge";
import { ACCOUNT_CALLSIGN_HELP } from "../tower/callsignTooltips";

type Props = {
  user: AuthUser;
  /** Bubble the renamed user back up so AppShell + topbar update without a full reload. */
  onUserUpdated?: (next: AuthUser) => void;
};

type ActiveEntry = {
  kind: "ban" | "mute";
  expiresAt?: string;
  reason?: string;
};

type PastEntry = {
  id: string;
  at: string;
  action: "admin.ban" | "admin.mute" | "admin.kick" | "admin.banIp";
  actorUserId: string;
  expiresAt?: string;
  durationSeconds?: number;
  reason?: string;
  roomName?: string;
};

type ModerationHistoryResponse = {
  ok?: boolean;
  active?: ActiveEntry[];
  past?: PastEntry[];
};

const DISPLAY_NAME_MAX = 120;

function formatAge(iso: string | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/** Human-readable duration for the action history table (e.g. "5m", "24h", "permanent"). */
function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "permanent";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** "Expires in 4m" / "Expired 2h ago" / "Permanent" for the active-bans card. */
function formatExpiry(expiresAt: string | undefined, nowMs: number): string {
  if (!expiresAt) return "Permanent";
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return expiresAt;
  const remaining = Math.round((t - nowMs) / 1000);
  if (remaining > 0) {
    if (remaining < 60) return `expires in ${remaining}s`;
    if (remaining < 3600) return `expires in ${Math.ceil(remaining / 60)}m`;
    if (remaining < 86_400) return `expires in ${Math.ceil(remaining / 3600)}h`;
    return `expires in ${Math.ceil(remaining / 86_400)}d`;
  }
  return `expired ${formatAge(expiresAt, nowMs)}`;
}

function actionLabel(action: PastEntry["action"]): string {
  switch (action) {
    case "admin.ban":
      return "Ban";
    case "admin.mute":
      return "Mute";
    case "admin.kick":
      return "Kick";
    case "admin.banIp":
      return "IP ban";
    default:
      return action;
  }
}

function actionTagClass(action: PastEntry["action"]): string {
  switch (action) {
    case "admin.ban":
    case "admin.banIp":
      return "tag-reported";
    case "admin.mute":
      return "tag-actor";
    case "admin.kick":
      return "tag-tower";
    default:
      return "tag-actor";
  }
}

/**
 * Per-user Settings page. Two responsibilities:
 *
 *   1. Self-serve display-name update. Posts to /v1/me/display-name; the
 *      override is preferred over the JWT-encoded name on subsequent
 *      /v1/auth/me reads, so the topbar updates as soon as we invalidate
 *      the auth/me query.
 *
 *   2. Personal moderation history. Reads /v1/me/moderation-history which
 *      surfaces the same active bans the admin Bans panel shows, plus a
 *      scan of the recent action_log filtered to entries that targeted
 *      this user (kicks / past bans / past mutes / IP bans).
 *
 * The page is intentionally read-mostly: there's nothing to "appeal" here,
 * just visibility into what was done and why. Mods still hold all the
 * actual buttons under /admin.
 */
/** Same lower bound the backend enforces (registerSchema / changePasswordSchema). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

export function SettingsPage({ user, onUserUpdated }: Props): JSX.Element {
  const qc = useQueryClient();
  const voiceSnap = useSyncExternalStore(subscribeVoiceTopBar, getVoiceTopBarSnapshot, getVoiceTopBarSnapshot);
  const voicePtt = getVoiceTopBarPtt();
  const showVoicePtt = Boolean(
    voicePtt && voiceSnap.present && voiceSnap.connected && voiceSnap.canPublish && voiceSnap.pttEnabled
  );
  const [draftName, setDraftName] = useState(user.displayName ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Change-password local state. Confirm field is client-side only — the backend
  // doesn't care, it's there to catch typos before we burn an argon2 hash + an
  // /auth/login retry.
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ text: string; isError: boolean } | null>(null);

  // Keep the editable input in sync if the user object updates from a
  // background /auth/me refetch (e.g. another tab renamed them).
  useEffect(() => {
    setDraftName(user.displayName ?? "");
  }, [user.displayName]);

  // Clock tick for "x ago" labels — same pattern as AdminDesk.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const historyQuery = useApiQuery<ModerationHistoryResponse>({
    queryKey: ["me", "moderation-history"],
    path: "/v1/me/moderation-history",
    refetchInterval: 30_000,
    placeholderData: (prev) => prev
  });

  const active = historyQuery.data?.active ?? [];
  const past = historyQuery.data?.past ?? [];
  const trimmedDraft = draftName.trim();
  const dirty = trimmedDraft !== (user.displayName ?? "").trim();
  const canSave = dirty && trimmedDraft.length > 0 && !savingName;

  const sortedPast = useMemo(
    () => [...past].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [past]
  );

  async function handleSubmitName(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSave) return;
    setSavingName(true);
    setNameMsg(null);
    try {
      await apiCall<{ ok: boolean; displayName: string; callsign?: string }>(
        "/v1/me/display-name",
        {
          method: "POST",
          body: JSON.stringify({ callsign: trimmedDraft, displayName: trimmedDraft })
        }
      );
      // Pull the canonical /auth/me so capabilities/role come back
      // alongside the name — no risk of optimistically updating one
      // field and stale-overwriting another.
      const me = await apiCall<{ user?: unknown }>("/v1/auth/me");
      const next = authUserFromResponse(me?.user ?? null);
      if (next) {
        setStoredUser(next);
        onUserUpdated?.(next);
      }
      void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
      setNameMsg({ text: "Callsign updated.", isError: false });
    } catch (err) {
      const text =
        err instanceof ApiError ? (err.unreachable ? "API unreachable" : err.message)
        : err instanceof Error ? err.message
        : String(err);
      setNameMsg({ text, isError: true });
    } finally {
      setSavingName(false);
    }
  }

  // Allow the form to render but don't bother POSTing for principals that
  // can't possibly succeed: guests have no credentials and plugin/dev tokens
  // never carry an email. The backend does its own check (and returns
  // `password_managed_by_operator` for env-managed accounts) so we still
  // surface that as a soft error rather than hiding the form entirely — the
  // operator might have moved the user from env to self-serve.
  const canChangePassword = !user.isGuest && !!user.email;
  const pwTrimmed = {
    current: pwCurrent,
    next: pwNew,
    confirm: pwConfirm
  };
  const pwValid =
    pwTrimmed.current.length > 0 &&
    pwTrimmed.next.length >= PASSWORD_MIN &&
    pwTrimmed.next.length <= PASSWORD_MAX &&
    pwTrimmed.next === pwTrimmed.confirm &&
    pwTrimmed.next !== pwTrimmed.current;
  const pwCanSave = canChangePassword && pwValid && !savingPw;

  async function handleSubmitPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!pwCanSave) return;
    setSavingPw(true);
    setPwMsg(null);
    try {
      await apiCall<{ ok: boolean }>("/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: pwTrimmed.current,
          newPassword: pwTrimmed.next
        })
      });
      setPwCurrent("");
      setPwNew("");
      setPwConfirm("");
      setPwMsg({ text: "Password updated. Use the new one next time you sign in.", isError: false });
    } catch (err) {
      const text =
        err instanceof ApiError ? (err.unreachable ? "API unreachable" : err.message)
        : err instanceof Error ? err.message
        : String(err);
      setPwMsg({ text, isError: true });
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>
            Update your pilot callsign for the lobby and voice rooms, and review any
            moderation actions on your account.
          </p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="card settings-card">
          <div className="card-head">
            <h2>Profile</h2>
            <span className="chat-meta">Visible to other pilots and controllers</span>
          </div>
          <form onSubmit={(e) => void handleSubmitName(e)} className="settings-form">
            <label className="settings-label" htmlFor="settings-callsign" title={ACCOUNT_CALLSIGN_HELP}>
              Callsign
            </label>
            <div className="settings-input-row">
              <input
                id="settings-callsign"
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value.slice(0, DISPLAY_NAME_MAX))}
                maxLength={DISPLAY_NAME_MAX}
                spellCheck={false}
                autoComplete="off"
                placeholder={user.email ?? "Your callsign"}
                disabled={savingName}
                title={ACCOUNT_CALLSIGN_HELP}
              />
              <button type="submit" disabled={!canSave}>
                {savingName ? "Saving…" : "Save"}
              </button>
              {dirty ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(user.displayName ?? "");
                    setNameMsg(null);
                  }}
                  disabled={savingName}
                >
                  Reset
                </button>
              ) : null}
            </div>
            <p className="settings-hint">
              {trimmedDraft.length}/{DISPLAY_NAME_MAX} characters. Same value as your in-game plugin
              callsign and account display name — shown in chat, voice rooms, and the lobby roster.
            </p>
            {nameMsg ? (
              <p className={`msg ${nameMsg.isError ? "error" : "ok"}`}>{nameMsg.text}</p>
            ) : null}
          </form>

          <dl className="settings-meta">
            <div>
              <dt>User ID</dt>
              <dd><code>{user.id}</code></dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{user.email ?? <span className="dim">none (guest)</span>}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{user.role}</dd>
            </div>
          </dl>
        </section>

        <section className="card settings-card">
          <div className="card-head">
            <h2>Voice transmit</h2>
            <span className="chat-meta">Push-to-talk only · T</span>
          </div>
          <p className="settings-hint" style={{ marginTop: 0 }}>
            The web client keeps your microphone muted until you transmit. Hold <strong>T</strong> while
            this tab is focused (skipped when the cursor is in a text field), or press and hold the
            button below. The same control appears in the top bar when you are in a tower session.
          </p>
          {showVoicePtt && voicePtt ? (
            <div className="settings-input-row" style={{ marginTop: "0.75rem", alignItems: "center" }}>
              <button
                type="button"
                className={`voice-ptt-pill ${voiceSnap.micHot ? "held" : "armed"}`}
                onPointerDown={voicePtt.onPointerDown}
                onPointerUp={voicePtt.onPointerUp}
                onPointerCancel={voicePtt.onPointerUp}
                onContextMenu={(e) => e.preventDefault()}
                aria-pressed={voiceSnap.micHot}
                aria-label="Push to talk — hold to transmit"
                title="Hold to transmit to LiveKit"
              >
                <span className="voice-ptt-key" aria-hidden>
                  T
                </span>
                <span>{voiceSnap.micHot ? "Talking" : "Hold to talk"}</span>
              </button>
            </div>
          ) : (
            <p className="dim settings-empty" style={{ marginTop: "0.75rem" }}>
              {!voiceSnap.present
                ? "Join a tower session from the Lobby so the voice desk is active, then connect from the Tower Voice card (or stay on Tower while using voice)."
                : voiceSnap.connecting || voiceSnap.reconnecting
                  ? "Voice is connecting…"
                  : voiceSnap.connected && !voiceSnap.canPublish
                    ? "You are in listen-only voice for this session — publishing controls stay hidden."
                    : "Not transmitting right now. Open Tower and tap Join voice, then return here or use the top-bar PTT control."}
            </p>
          )}
        </section>

        <section className="card settings-card">
          <div className="card-head">
            <h2>Password</h2>
            <span className="chat-meta">Same credentials as the in-game plugin</span>
          </div>
          {!canChangePassword ? (
            <p className="dim settings-empty">
              {user.isGuest
                ? "Guest accounts have no password. Sign up for a permanent account from the landing page to get one."
                : "This account does not have a password configured here."}
            </p>
          ) : (
            <form onSubmit={(e) => void handleSubmitPassword(e)} className="settings-form">
              <label className="settings-label" htmlFor="settings-pw-current">
                Current password
              </label>
              <input
                id="settings-pw-current"
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value.slice(0, PASSWORD_MAX))}
                maxLength={PASSWORD_MAX}
                autoComplete="current-password"
                disabled={savingPw}
                spellCheck={false}
              />
              <label className="settings-label" htmlFor="settings-pw-new" style={{ marginTop: "0.55rem" }}>
                New password
              </label>
              <input
                id="settings-pw-new"
                type="password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value.slice(0, PASSWORD_MAX))}
                maxLength={PASSWORD_MAX}
                autoComplete="new-password"
                disabled={savingPw}
                spellCheck={false}
                placeholder={`At least ${PASSWORD_MIN} characters`}
              />
              <label className="settings-label" htmlFor="settings-pw-confirm" style={{ marginTop: "0.55rem" }}>
                Confirm new password
              </label>
              <div className="settings-input-row">
                <input
                  id="settings-pw-confirm"
                  type="password"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value.slice(0, PASSWORD_MAX))}
                  maxLength={PASSWORD_MAX}
                  autoComplete="new-password"
                  disabled={savingPw}
                  spellCheck={false}
                />
                <button type="submit" disabled={!pwCanSave}>
                  {savingPw ? "Saving…" : "Change password"}
                </button>
              </div>
              <p className="settings-hint">
                Used both here and to log into the in-game plugin. After
                changing it you'll stay signed in on this device.
                {pwTrimmed.next.length > 0 && pwTrimmed.next.length < PASSWORD_MIN ? (
                  <> Needs at least {PASSWORD_MIN} characters ({pwTrimmed.next.length} so far).</>
                ) : null}
                {pwTrimmed.confirm.length > 0 && pwTrimmed.next !== pwTrimmed.confirm ? (
                  <> Confirmation does not match new password.</>
                ) : null}
                {pwTrimmed.next.length > 0 && pwTrimmed.next === pwTrimmed.current ? (
                  <> New password must differ from current password.</>
                ) : null}
              </p>
              {pwMsg ? (
                <p className={`msg ${pwMsg.isError ? "error" : "ok"}`}>{pwMsg.text}</p>
              ) : null}
            </form>
          )}
        </section>

        <section className="card settings-card">
          <div className="card-head">
            <h2>Active restrictions</h2>
            <div className="admin-feed-actions">
              <span className="chat-meta">{active.length} in force</span>
              <button
                type="button"
                className="admin-feed-refresh"
                onClick={() =>
                  void qc.invalidateQueries({ queryKey: ["me", "moderation-history"] })
                }
                disabled={historyQuery.isFetching}
              >
                {historyQuery.isFetching ? "…" : "Refresh"}
              </button>
            </div>
          </div>
          {historyQuery.error ? (
            <p className="msg error">
              {historyQuery.error.unreachable ? "API unreachable" : historyQuery.error.message}
            </p>
          ) : null}
          {active.length === 0 ? (
            <p className="dim settings-empty">
              You have no active bans or mutes. You're clear.
            </p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((entry, i) => (
                    <tr key={`${entry.kind}-${i}`}>
                      <td>
                        <span className={`admin-user-tag ${actionTagClass(entry.kind === "ban" ? "admin.ban" : "admin.mute")}`}>
                          {entry.kind === "ban" ? "Ban" : "Mute"}
                        </span>
                      </td>
                      <td className="dim">{formatExpiry(entry.expiresAt, nowTick)}</td>
                      <td>{entry.reason ?? <span className="dim">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card settings-card admin-card-wide">
          <div className="card-head">
            <h2>History</h2>
            <span className="chat-meta">
              {sortedPast.length === 0
                ? "Nothing recorded"
                : `${sortedPast.length} action${sortedPast.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {sortedPast.length === 0 ? (
            <p className="dim settings-empty">
              No past kicks, mutes, or bans on file. Recent moderation actions
              against your account will show up here.
            </p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Duration</th>
                    <th>Reason</th>
                    <th>Where / by</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPast.map((entry) => (
                    <tr key={entry.id}>
                      <td className="dim" title={entry.at}>{formatAge(entry.at, nowTick)}</td>
                      <td>
                        <span className={`admin-user-tag ${actionTagClass(entry.action)}`}>
                          {actionLabel(entry.action)}
                        </span>
                      </td>
                      <td className="dim">{formatDuration(entry.durationSeconds)}</td>
                      <td>{entry.reason ?? <span className="dim">—</span>}</td>
                      <td className="dim">
                        {entry.roomName ? (
                          <code className="settings-roomname">{entry.roomName}</code>
                        ) : null}
                        {entry.actorUserId ? (
                          <span title={`Issued by ${entry.actorUserId}`}>
                            by <code>{entry.actorUserId}</code>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="settings-hint">
            History covers the most recent moderator actions on this account.
            If you believe an action was issued in error, contact a mod in the
            lobby.
          </p>
        </section>
      </div>
    </>
  );
}
