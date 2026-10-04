import { useEffect, useMemo, useState } from "react";
import type { Role } from "../auth/session";
import { useAuthMe } from "../auth/useAuthMe";
import { queryKeys } from "../query/client";
import { ApiError, apiCall, useApiQuery, useQueryClient } from "../query/hooks";

type InviteCode = {
  code: string;
  role: Role | null;
  createdByUserId: string;
  createdAt: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  label: string;
};

/** Roles that can be pinned to an invite code. Owner is excluded server-side too. */
const INVITE_ROLES: ReadonlyArray<Role> = [
  "guest",
  "pilot",
  "controller",
  "mod",
  "supermod"
];

/** Try the modern Clipboard API; fall back to a hidden textarea for non-HTTPS dev. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The Owner desk is the home for operations that the *server owner* alone
 * can perform — currently just role grants (POST /v1/admin/role, gated by
 * `requireRole("owner")` on the backend), but this page is the parking
 * spot for any future owner-only knob (server config, owner audit, etc.)
 * so they don't have to keep getting bolted onto AdminDesk and hidden
 * behind `isOwner` checks.
 *
 * Why a separate page from Admin:
 *  - Admin is mod+ scope. Owner-only controls were previously inline
 *    `prompt()` buttons inside AdminDesk; that mixes two privilege tiers
 *    into one screen and makes it easy to mis-aim a click.
 *  - Owner gets a dedicated tab so the owner-only surface is obvious
 *    (and so non-owners never see the controls at all).
 *  - Role assignment now uses a proper select dropdown instead of a
 *    free-text `prompt()` — fewer typos, clearer affordance.
 */

type Principal = {
  userId: string;
  displayName: string;
  isBridge: boolean;
  role?: string;
  email?: string;
};

type LogRow = {
  id: string;
  at: string;
  actorUserId: string;
  action: string;
  metadata?: Record<string, unknown>;
};

/** Roles the owner can assign. `owner` itself is set via env (see backend). */
const ASSIGNABLE_ROLES: ReadonlyArray<Role> = [
  "guest",
  "pilot",
  "controller",
  "mod",
  "supermod"
];

function formatAge(iso: string | null | undefined, nowMs: number): string {
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

export function OwnerDesk(): JSX.Element {
  const me = useAuthMe().user;
  const isOwner = me?.isOwner === true;
  const qc = useQueryClient();
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [query, setQuery] = useState("");
  const [pendingRole, setPendingRole] = useState<Record<string, Role>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    userId: string;
    text: string;
    isError: boolean;
  } | null>(null);

  // Invite-code form state. Kept local because it's a one-shot create flow —
  // no draft to persist between re-renders. `expiresAt` is `datetime-local`
  // so the value is naive (no timezone); we serialize it back to ISO via
  // `new Date(...).toISOString()` so the backend stores UTC.
  const [inviteRole, setInviteRole] = useState<Role | "">(""); // "" = REGISTRATION_DEFAULT_ROLE
  const [inviteMaxUses, setInviteMaxUses] = useState<string>("1");
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string>("");
  const [inviteLabel, setInviteLabel] = useState<string>("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ text: string; isError: boolean } | null>(null);
  /** code → "Copied!" | "Copy failed" — auto-clears after a couple seconds. */
  const [copyHint, setCopyHint] = useState<Record<string, string>>({});

  // Password-reset action state. The freshly minted password is shown ONCE in
  // a banner; we keep it in component state (not the cache) because surfacing
  // it through TanStack would risk it living forever in devtools / hydration.
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{
    userId: string;
    newPassword: string;
  } | null>(null);
  const [resetError, setResetError] = useState<{ userId: string; text: string } | null>(null);

  // Reuse the principals + logs endpoints already exposed for AdminDesk.
  // Owner is mod+, so both calls are authorised. Sharing the cache keys
  // means a role change here also refreshes the Admin view's directory
  // without a second round-trip.
  const principalsQuery = useApiQuery<{ ok?: boolean; principals?: Principal[] }>({
    queryKey: queryKeys.admin.users,
    path: "/v1/admin/principals",
    staleTime: 15_000,
    placeholderData: (prev) => prev
  });

  const logsQuery = useApiQuery<{ ok?: boolean; logs?: LogRow[] }>({
    queryKey: queryKeys.admin.actionLog,
    path: "/v1/admin/logs?limit=200",
    placeholderData: (prev) => prev
  });

  const invitesQuery = useApiQuery<{ ok?: boolean; codes?: InviteCode[] }>({
    queryKey: queryKeys.admin.inviteCodes,
    path: "/v1/admin/invite-codes",
    staleTime: 30_000,
    placeholderData: (prev) => prev
  });
  const invites = useMemo(() => invitesQuery.data?.codes ?? [], [invitesQuery.data]);

  // Auto-clear the per-row "Copied!" hints so they don't pile up forever.
  useEffect(() => {
    if (Object.keys(copyHint).length === 0) return;
    const t = window.setTimeout(() => setCopyHint({}), 2200);
    return () => window.clearTimeout(t);
  }, [copyHint]);

  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Filter the audit log down to role-change events. The action string the
  // backend writes is `admin.role` (see services/repository setUserRole).
  const roleChangeLog = useMemo(() => {
    const rows = logsQuery.data?.logs ?? [];
    return rows.filter((r) => r.action === "admin.role").slice(0, 25);
  }, [logsQuery.data]);

  const principals = useMemo<Principal[]>(() => {
    const list = principalsQuery.data?.principals ?? [];
    // The voice bridge is a service principal — it has no human role to
    // grant, so hide it from the owner picker entirely.
    return list.filter((p) => !p.isBridge);
  }, [principalsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return principals;
    return principals.filter((p) =>
      p.userId.toLowerCase().includes(q) ||
      (p.displayName ?? "").toLowerCase().includes(q) ||
      (p.email ?? "").toLowerCase().includes(q) ||
      (p.role ?? "").toLowerCase().includes(q)
    );
  }, [principals, query]);

  async function applyRole(userId: string, role: Role): Promise<void> {
    setBusyId(userId);
    setFeedback(null);
    try {
      await apiCall<{ ok?: boolean }>("/v1/admin/role", {
        method: "POST",
        body: JSON.stringify({ userId, role })
      });
      setFeedback({ userId, text: `Role set to ${role}.`, isError: false });
      // Bump both feeds: directory (so the new role renders here) and
      // action log (so the change shows up in "Recent role changes").
      void qc.invalidateQueries({ queryKey: queryKeys.admin.users });
      void qc.invalidateQueries({ queryKey: queryKeys.admin.actionLog });
      // Clear the staged dropdown so the row snaps back to "current role".
      setPendingRole((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    } catch (e) {
      const msg =
        e instanceof ApiError ? (e.unreachable ? "API unreachable" : e.message)
        : e instanceof Error ? e.message
        : String(e);
      setFeedback({ userId, text: msg, isError: true });
    } finally {
      setBusyId(null);
    }
  }

  async function createInvite(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreatingInvite(true);
    setInviteMsg(null);
    try {
      const maxUses = Math.max(1, Math.min(1000, Math.floor(Number(inviteMaxUses) || 1)));
      const expiresAtIso = inviteExpiresAt
        ? new Date(inviteExpiresAt).toISOString()
        : null;
      const body: Record<string, unknown> = { maxUses };
      if (inviteRole) body.role = inviteRole;
      if (expiresAtIso) body.expiresAt = expiresAtIso;
      if (inviteLabel.trim()) body.label = inviteLabel.trim();
      const created = await apiCall<{ ok: boolean; invite: InviteCode }>(
        "/v1/admin/invite-codes",
        { method: "POST", body: JSON.stringify(body) }
      );
      void qc.invalidateQueries({ queryKey: queryKeys.admin.inviteCodes });
      setInviteMaxUses("1");
      setInviteExpiresAt("");
      setInviteLabel("");
      setInviteRole("");
      // Auto-copy the new code so the operator can immediately paste it into
      // a Discord DM. If clipboard access is denied, the inline button on the
      // table row is the fallback.
      const copied = await copyToClipboard(created.invite.code);
      setInviteMsg({
        text: copied
          ? `Created ${created.invite.code} (copied to clipboard).`
          : `Created ${created.invite.code}. Use the Copy button to grab it.`,
        isError: false
      });
    } catch (err) {
      const text =
        err instanceof ApiError ? (err.unreachable ? "API unreachable" : err.message)
        : err instanceof Error ? err.message
        : String(err);
      setInviteMsg({ text, isError: true });
    } finally {
      setCreatingInvite(false);
    }
  }

  async function revokeInvite(code: string): Promise<void> {
    setInviteMsg(null);
    try {
      await apiCall<{ ok: boolean }>(`/v1/admin/invite-codes/${encodeURIComponent(code)}`, {
        method: "DELETE"
      });
      void qc.invalidateQueries({ queryKey: queryKeys.admin.inviteCodes });
      setInviteMsg({ text: `Revoked ${code}.`, isError: false });
    } catch (err) {
      const text =
        err instanceof ApiError ? (err.unreachable ? "API unreachable" : err.message)
        : err instanceof Error ? err.message
        : String(err);
      setInviteMsg({ text: `Revoke failed: ${text}`, isError: true });
    }
  }

  async function handleCopyCode(code: string): Promise<void> {
    const ok = await copyToClipboard(code);
    setCopyHint((prev) => ({ ...prev, [code]: ok ? "Copied!" : "Copy failed" }));
  }

  async function resetPasswordFor(userId: string): Promise<void> {
    // No window.confirm — modal-style prompts inside a SPA are jarring and the
    // freshly minted password banner is a clear after-the-fact "yep, I did it"
    // confirmation. The action is also reversible (just reset again).
    setResetBusyId(userId);
    setResetError(null);
    setResetResult(null);
    try {
      const data = await apiCall<{ ok: boolean; userId: string; newPassword: string }>(
        `/v1/admin/users/${encodeURIComponent(userId)}/reset-password`,
        { method: "POST", body: "{}" }
      );
      setResetResult({ userId: data.userId, newPassword: data.newPassword });
    } catch (err) {
      const text =
        err instanceof ApiError ? (err.unreachable ? "API unreachable" : err.message)
        : err instanceof Error ? err.message
        : String(err);
      setResetError({ userId, text });
    } finally {
      setResetBusyId(null);
    }
  }

  if (!isOwner) {
    // Defence in depth: route guard already redirects non-owners, but if
    // someone lands here via stale cache we want a visible bounce rather
    // than a half-rendered admin surface.
    return (
      <>
        <header className="page-header">
          <div>
            <h1>Owner</h1>
            <p>This console is restricted to the server owner.</p>
          </div>
        </header>
        <div className="card">
          <p>You are signed in as <code>{me?.role ?? "unknown"}</code>. Only the
          principal configured as <code>OWNER_USER_ID</code> on the backend can
          use this page.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Owner</h1>
          <p>
            Server owner console. Grant or revoke <code>mod</code> /{" "}
            <code>supermod</code> / <code>controller</code> / <code>pilot</code>{" "}
            roles. The <code>owner</code> role itself is fixed by{" "}
            <code>OWNER_USER_ID</code> in the backend env and cannot be granted
            from the API.
          </p>
        </div>
      </header>

      <div className="owner-grid">
        <div className="card admin-card-wide owner-roles-card">
          <div className="card-head">
            <h2>Roles</h2>
            <div className="admin-feed-actions">
              <span className="chat-meta">
                {filtered.length}/{principals.length} principals
              </span>
              <button
                type="button"
                className="admin-feed-refresh"
                onClick={() => void qc.invalidateQueries({ queryKey: queryKeys.admin.users })}
                disabled={principalsQuery.isFetching}
                title="Reload principals"
              >
                {principalsQuery.isFetching ? "…" : "Refresh"}
              </button>
            </div>
          </div>

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="owner-search-input"
            placeholder="Search by user id, display name, email, or current role…"
            spellCheck={false}
            autoComplete="off"
          />

          {feedback ? (
            <p className={`msg owner-feedback ${feedback.isError ? "error" : "ok"}`}>
              {feedback.userId}: {feedback.text}
            </p>
          ) : null}

          {principalsQuery.error ? (
            <p className="msg error owner-feedback">
              {principalsQuery.error.unreachable ? "API unreachable" : principalsQuery.error.message}
            </p>
          ) : null}

          {principals.length === 0 && !principalsQuery.isLoading ? (
            <p className="owner-empty">
              No configured principals visible.
            </p>
          ) : (
            <div className="admin-table-wrap owner-table-wrap">
              <table className="admin-table owner-roles-table">
                <thead>
                  <tr>
                    <th>Principal</th>
                    <th>Email</th>
                    <th>Current role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const currentRole = (p.role ?? "pilot") as Role;
                    const isImmuneOwner = currentRole === "owner";
                    const staged = pendingRole[p.userId] ?? currentRole;
                    const isMe = me?.id === p.userId;
                    const busy = busyId === p.userId;
                    const dirty = staged !== currentRole;
                    return (
                      <tr key={p.userId}>
                        <td>
                          <span className="owner-principal-cell">
                            <span className="owner-principal-name">{p.displayName || p.userId}</span>
                            {p.displayName && p.displayName !== p.userId ? (
                              <code className="owner-principal-id">{p.userId}</code>
                            ) : null}
                            {isMe ? (
                              <span className="owner-principal-self">(you)</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="dim">{p.email ?? "—"}</td>
                        <td>
                          <span
                            className={`app-topbar-role owner-role-pill owner-role-current role-${currentRole}`}
                            title={`Current role: ${currentRole}`}
                          >
                            {currentRole}
                          </span>
                        </td>
                        <td>
                          <div className="owner-row-actions">
                            <select
                              className="owner-role-select"
                              value={staged}
                              onChange={(e) =>
                                setPendingRole((prev) => ({
                                  ...prev,
                                  [p.userId]: e.target.value as Role
                                }))
                              }
                              disabled={busy || isImmuneOwner}
                              title={isImmuneOwner ? "Owner is fixed by OWNER_USER_ID" : `Choose new role for ${p.userId}`}
                            >
                              {ASSIGNABLE_ROLES.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="owner-apply-btn"
                              onClick={() => void applyRole(p.userId, staged)}
                              disabled={busy || !dirty || isImmuneOwner}
                              title={
                                isImmuneOwner ? "Owner role is env-pinned, cannot be changed via API"
                                : !dirty ? "No change to apply"
                                : `Set ${p.userId} to ${staged}`
                              }
                            >
                              {busy ? "…" : "Apply"}
                            </button>
                            {/* The backend rejects this for non-registered users with
                              * `not_registered`, so we don't try to detect the source
                              * client-side — just surface the error inline if it fails. */}
                            <button
                              type="button"
                              className="owner-reset-btn owner-secondary-btn"
                              onClick={() => void resetPasswordFor(p.userId)}
                              disabled={resetBusyId === p.userId || isImmuneOwner}
                              title={
                                isImmuneOwner
                                  ? "Owner password is set in env, not here"
                                  : `Generate a new password for ${p.userId}`
                              }
                            >
                              {resetBusyId === p.userId ? "…" : "Reset pwd"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {resetResult ? (
            <div className="msg ok owner-reset-banner">
              <div>
                New password for <code>{resetResult.userId}</code>. Show this once,
                then close this banner — it will not be shown again:
              </div>
              <div className="owner-reset-banner-actions">
                <code className="owner-reset-banner-code">
                  {resetResult.newPassword}
                </code>
                <button
                  type="button"
                  onClick={() => void copyToClipboard(resetResult.newPassword)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setResetResult(null)}
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}
          {resetError ? (
            <p className="msg error owner-feedback">
              Reset for <code>{resetError.userId}</code>: {resetError.text}
            </p>
          ) : null}
        </div>

        <div className="card admin-feed-card owner-rolelog-card">
          <div className="card-head">
            <h2>Recent role changes</h2>
            <div className="admin-feed-actions">
              <span className="chat-meta">{roleChangeLog.length} entries</span>
              <button
                type="button"
                className="admin-feed-refresh"
                onClick={() => void qc.invalidateQueries({ queryKey: queryKeys.admin.actionLog })}
                disabled={logsQuery.isFetching}
                title="Reload audit log"
              >
                {logsQuery.isFetching ? "…" : "Refresh"}
              </button>
            </div>
          </div>
          {logsQuery.error ? (
            <p className="msg error owner-feedback owner-feedback-bottom">
              {logsQuery.error.unreachable ? "API unreachable" : logsQuery.error.message}
            </p>
          ) : null}
          {roleChangeLog.length === 0 ? (
            <p className="owner-empty owner-empty-tight">
              No role grants logged yet.
            </p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table owner-rolelog-table">
                <thead>
                  <tr><th>When</th><th>Actor</th><th>Target</th><th>New role</th></tr>
                </thead>
                <tbody>
                  {roleChangeLog.map((log) => {
                    const meta = log.metadata ?? {};
                    const target = typeof meta.userId === "string" ? meta.userId
                      : typeof meta.targetUserId === "string" ? meta.targetUserId
                      : "—";
                    const newRole = typeof meta.role === "string" ? meta.role : "—";
                    return (
                      <tr key={log.id}>
                        <td className="dim">{formatAge(log.at, nowTick)}</td>
                        <td className="dim">{log.actorUserId}</td>
                        <td className="mono">{target}</td>
                        <td>
                          <span className={`app-topbar-role owner-role-pill role-${newRole}`}>
                            {newRole}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card admin-card-wide owner-invites-card">
          <div className="card-head">
            <h2>Invite codes</h2>
            <div className="admin-feed-actions">
              <span className="chat-meta">{invites.length} on file</span>
              <button
                type="button"
                className="admin-feed-refresh"
                onClick={() => void qc.invalidateQueries({ queryKey: queryKeys.admin.inviteCodes })}
                disabled={invitesQuery.isFetching}
                title="Reload invite codes"
              >
                {invitesQuery.isFetching ? "…" : "Refresh"}
              </button>
            </div>
          </div>
          <div className="owner-invite-create">
            <p className="owner-invite-hint">
              Use these when registration is <code>invite_only</code> or{" "}
              <code>open_or_invite</code>. The code&apos;s role overrides the server
              default at signup. Codes are case-insensitive; leave <em>Max uses</em> at
              1 for single-use.
            </p>

            <form onSubmit={(e) => void createInvite(e)} className="owner-invite-form">
              <div className="owner-invite-field">
                <label className="owner-invite-label" htmlFor="invite-role">Role on redemption</label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role | "")}
                  disabled={creatingInvite}
                >
                  <option value="">(server default)</option>
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="owner-invite-field">
                <label className="owner-invite-label" htmlFor="invite-uses">Max uses</label>
                <input
                  id="invite-uses"
                  type="number"
                  min={1}
                  max={1000}
                  value={inviteMaxUses}
                  onChange={(e) => setInviteMaxUses(e.target.value)}
                  disabled={creatingInvite}
                />
              </div>
              <div className="owner-invite-field owner-invite-field-wide">
                <label className="owner-invite-label" htmlFor="invite-expires">Expires (optional)</label>
                <input
                  id="invite-expires"
                  type="datetime-local"
                  value={inviteExpiresAt}
                  onChange={(e) => setInviteExpiresAt(e.target.value)}
                  disabled={creatingInvite}
                />
              </div>
              <div className="owner-invite-field owner-invite-field-grow">
                <label className="owner-invite-label" htmlFor="invite-label">Label (optional)</label>
                <input
                  id="invite-label"
                  type="text"
                  value={inviteLabel}
                  onChange={(e) => setInviteLabel(e.target.value.slice(0, 120))}
                  placeholder="e.g. Discord LFG — April batch"
                  disabled={creatingInvite}
                  maxLength={120}
                />
              </div>
              <div className="owner-invite-submit">
                <button type="submit" disabled={creatingInvite}>
                  {creatingInvite ? "Creating…" : "Create invite"}
                </button>
              </div>
            </form>
          </div>
          {inviteMsg ? (
            <p className={`msg owner-feedback ${inviteMsg.isError ? "error" : "ok"}`}>
              {inviteMsg.text}
            </p>
          ) : null}
          {invitesQuery.error ? (
            <p className="msg error owner-feedback">
              {invitesQuery.error.unreachable ? "API unreachable" : invitesQuery.error.message}
            </p>
          ) : null}

          {invites.length === 0 && !invitesQuery.isLoading ? (
            <p className="owner-empty">
              No invite codes yet. Create one above.
            </p>
          ) : (
            <>
              <p className="owner-invite-list-lead">Existing codes</p>
              <div className="admin-table-wrap owner-table-wrap owner-invite-table-wrap">
              <table className="admin-table owner-invites-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Role</th>
                    <th>Uses</th>
                    <th>Expires</th>
                    <th>Label</th>
                    <th>Created</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((c) => {
                    const exhausted = c.uses >= c.maxUses;
                    const expired = !!c.expiresAt && Date.parse(c.expiresAt) < nowTick;
                    const status =
                      exhausted ? "exhausted"
                      : expired ? "expired"
                      : "active";
                    const expiresLabel = c.expiresAt
                      ? `${new Date(c.expiresAt).toLocaleString()}${expired ? " (past)" : ""}`
                      : "never";
                    return (
                      <tr key={c.code} className={status === "active" ? "" : "owner-invite-row-muted"}>
                        <td>
                          <span className="owner-code-actions">
                            <code className="mono">{c.code}</code>
                            <button
                              type="button"
                              onClick={() => void handleCopyCode(c.code)}
                              title="Copy code"
                            >
                              {copyHint[c.code] ?? "Copy"}
                            </button>
                          </span>
                        </td>
                        <td>
                          {c.role ? (
                            <span className={`app-topbar-role owner-role-pill role-${c.role}`}>
                              {c.role}
                            </span>
                          ) : (
                            <span className="dim">default</span>
                          )}
                        </td>
                        <td className="dim">{c.uses}/{c.maxUses}</td>
                        <td className="dim" title={c.expiresAt ?? "never"}>{expiresLabel}</td>
                        <td>{c.label ? c.label : <span className="dim">—</span>}</td>
                        <td className="dim" title={`${c.createdAt} by ${c.createdByUserId}`}>
                          {formatAge(c.createdAt, nowTick)}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => void revokeInvite(c.code)}
                            title={`Revoke ${c.code}`}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
