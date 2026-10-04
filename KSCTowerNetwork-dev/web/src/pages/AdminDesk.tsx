import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "../auth/session";
import { useAuthMe } from "../auth/useAuthMe";
import { queryKeys } from "../query/client";
import { ApiError, apiCall, useApiQuery, useQueryClient } from "../query/hooks";

type ServerLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type ServerLogEntry = {
  seq: number;
  at: string;
  level: ServerLogLevel;
  msg: string;
  name?: string;
  pid?: number;
  hostname?: string;
  meta?: Record<string, unknown>;
};

const SERVER_LOG_TAIL_INTERVAL_MS = 2000;
const SERVER_LOG_MAX_RETAINED = 500;
const SERVER_LOG_LEVELS: ServerLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

// Mirror of backend `ROLE_RANK` (services/repository.ts). Used to cap Role…
// grants so a mod can't promote anyone to mod+ and can't rewrite a peer.
const ROLE_RANK: Record<Role, number> = {
  guest: 0,
  pilot: 1,
  controller: 2,
  mod: 3,
  supermod: 4,
  owner: 5
};
// Order shown in the role <select>. Owner is intentionally absent — it's set
// via OWNER_USER_ID on the backend and the API rejects it.
const GRANTABLE_ROLE_ORDER: Role[] = ["guest", "pilot", "controller", "mod", "supermod"];

type Report = {
  id: string;
  reporterUserId: string;
  targetUserId?: string;
  sessionId?: string;
  reason: string;
  createdAt: string;
};

type LogRow = {
  id: string;
  at: string;
  actorUserId: string;
  action: string;
  metadata?: Record<string, unknown>;
};

type TowerRoom = {
  id: string;
  pilotUserId: string;
  assignedTowerUserId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ChatRoomRow = {
  sessionId: string;
  messageCount: number;
  lastMessageAt?: string;
};

type SanctionEntry = {
  userId: string;
  kind: "ban" | "mute";
  ip?: string;
  expiresAt?: string;
  reason?: string;
};

type KickCooldown = {
  identity: string;
  roomName: string;
  expiresAt: string;
  remainingSec: number;
};

type SanctionsPayload = {
  bans: SanctionEntry[];
  mutes: SanctionEntry[];
  kickCooldowns: KickCooldown[];
};

/**
 * State shape for the inline issuance editor (mute / kick / temp-ban /
 * perm-ban / ban-IP). Lives at module scope so the dedicated `ActionEditor`
 * component can be typed without a circular import. See `openActionEditor`
 * for how each kind seeds defaults.
 *   - durationInput: minutes for mute/kick, hours for tempban/banip,
 *     unused for permban. Stored as a string so we can let the user type
 *     freely without React fighting the input cursor.
 *   - roomName: bare sessionId for kick (we prefix `tower-` on submit).
 *   - availableRooms: snapshot of the user's active rooms at the time the
 *     kick editor was opened, so the selector doesn't reshuffle if the
 *     tower-rooms feed refetches mid-edit.
 */
type PendingActionKind = "mute" | "kick" | "tempban" | "permban" | "banip";
type PendingAction = {
  userId: string;
  kind: PendingActionKind;
  durationInput: string;
  reason: string;
  roomName: string;
  availableRooms: string[];
};

type Principal = {
  userId: string;
  displayName: string;
  isBridge: boolean;
  role?: string;
  email?: string;
};

type PrincipalDirectory = {
  /** O(1) lookup of every principal the backend told us about. Includes bridges. */
  byId: Map<string, Principal>;
  /** userIds the admin Users panel must hide entirely (the KSP voice bridge etc.). */
  bridgeIds: Set<string>;
};

const EMPTY_DIRECTORY: PrincipalDirectory = { byId: new Map(), bridgeIds: new Set() };

/**
 * Pretty label for a userId. Configured users show their email local-part; the
 * voice bridge shows "KSP voice bridge"; unknown ids fall back to the raw id.
 * Always also shows the userId underneath in mono so admins can still copy it.
 */
function principalLabel(userId: string, dir: PrincipalDirectory): string {
  const p = dir.byId.get(userId);
  if (p && p.displayName && p.displayName !== userId) {
    return p.displayName;
  }
  return userId;
}

type FeedState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
};

/**
 * Map a TanStack query result into the legacy `FeedState` shape so the
 * existing `<FeedCard>` render code doesn't need to change. This keeps the
 * card subtitle / refresh button / loading spinner / error banner all
 * working without a per-card refactor.
 */
function feedFromQuery<TQ, TOut>(
  q: { data: TQ | undefined; isFetching: boolean; isLoading: boolean; error: { unreachable?: boolean; message: string } | null; dataUpdatedAt: number },
  pick: (data: TQ) => TOut
): FeedState<TOut> {
  return {
    data: q.data ? pick(q.data) : null,
    loading: q.isFetching || q.isLoading,
    error: q.error ? (q.error.unreachable ? "API unreachable" : q.error.message) : null,
    loadedAt: q.dataUpdatedAt > 0 ? q.dataUpdatedAt : null
  };
}

type DerivedUserRole = "pilot" | "tower" | "reporter" | "reported" | "actor";

type DerivedUser = {
  userId: string;
  roles: Set<DerivedUserRole>;
  lastSeenIso?: string;
  lastAction?: string;
  pilotInRooms: number;
  towerInRooms: number;
  reportsAgainst: number;
  reportsBy: number;
  logHits: number;
};

function isoNewer(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

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

/**
 * Forward-looking duration label for sanction expiry. Mirrors `formatAge`
 * but reads as "in 12m" / "expired" so an operator can scan a sanctions
 * row and see at a glance how much longer the timer has left.
 */
function formatExpiry(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "permanent";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.round((t - nowMs) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const d = Math.floor(hr / 24);
  return `in ${d}d`;
}

function deriveUsers(
  towerRooms: TowerRoom[] | null,
  reports: Report[] | null,
  logs: LogRow[] | null,
  bridgeIds: Set<string>
): DerivedUser[] {
  const map = new Map<string, DerivedUser>();
  const get = (id: string): DerivedUser | null => {
    // The KSP voice-bridge is a non-human subscriber that may legitimately
    // appear in audit logs (it calls /livekit-token). It must never be listed
    // as a "user" in the admin Users panel — there is no human to mute / ban /
    // rename here. Drop the row at the source so every code path below
    // (filtering, sorting, rendering) automatically skips it.
    if (bridgeIds.has(id)) return null;
    let u = map.get(id);
    if (!u) {
      u = {
        userId: id,
        roles: new Set(),
        pilotInRooms: 0,
        towerInRooms: 0,
        reportsAgainst: 0,
        reportsBy: 0,
        logHits: 0
      };
      map.set(id, u);
    }
    return u;
  };

  for (const room of towerRooms ?? []) {
    if (room.pilotUserId) {
      const u = get(room.pilotUserId);
      if (u) {
        u.roles.add("pilot");
        u.pilotInRooms += 1;
        u.lastSeenIso = isoNewer(u.lastSeenIso, room.updatedAt);
      }
    }
    if (room.assignedTowerUserId) {
      const u = get(room.assignedTowerUserId);
      if (u) {
        u.roles.add("tower");
        u.towerInRooms += 1;
        u.lastSeenIso = isoNewer(u.lastSeenIso, room.updatedAt);
      }
    }
  }
  for (const r of reports ?? []) {
    if (r.reporterUserId) {
      const u = get(r.reporterUserId);
      if (u) {
        u.roles.add("reporter");
        u.reportsBy += 1;
        u.lastSeenIso = isoNewer(u.lastSeenIso, r.createdAt);
      }
    }
    if (r.targetUserId) {
      const u = get(r.targetUserId);
      if (u) {
        u.roles.add("reported");
        u.reportsAgainst += 1;
        u.lastSeenIso = isoNewer(u.lastSeenIso, r.createdAt);
      }
    }
  }
  for (const l of logs ?? []) {
    if (!l.actorUserId) continue;
    const u = get(l.actorUserId);
    if (!u) continue;
    u.roles.add("actor");
    u.logHits += 1;
    if (!u.lastSeenIso || Date.parse(l.at) > Date.parse(u.lastSeenIso)) {
      u.lastSeenIso = l.at;
      u.lastAction = l.action;
    }
  }

  return [...map.values()].sort((a, b) => {
    const ta = a.lastSeenIso ? Date.parse(a.lastSeenIso) : 0;
    const tb = b.lastSeenIso ? Date.parse(b.lastSeenIso) : 0;
    return tb - ta;
  });
}

function roleLabel(r: DerivedUserRole): string {
  return r === "pilot" ? "Pilot"
    : r === "tower" ? "Tower"
    : r === "reporter" ? "Reporter"
    : r === "reported" ? "Reported"
    : "Actor";
}

export function AdminDesk(): JSX.Element {
  const [logFilter, setLogFilter] = useState<string>("");
  const [userQuery, setUserQuery] = useState("");
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    userId: string;
    text: string;
    isError: boolean;
  } | null>(null);
  // Inline role-editor state. We use an inline <select> instead of
  // `window.prompt` because the native prompt is unreliable in PWAs and
  // some Chromium dev contexts: it can auto-dismiss (returning null silently)
  // or immediately accept the default value, making the Role… button feel
  // like it's "just changing roles" without asking.
  const [roleEdit, setRoleEdit] = useState<{ userId: string; choice: Role } | null>(null);

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());

  const [serverLogs, setServerLogs] = useState<ServerLogEntry[]>([]);
  const [serverLogTailing, setServerLogTailing] = useState(true);
  const [serverLogMinLevel, setServerLogMinLevel] = useState<ServerLogLevel>("info");
  const [serverLogFilter, setServerLogFilter] = useState("");
  const [serverLogError, setServerLogError] = useState<string | null>(null);
  const [serverLogLoadedAt, setServerLogLoadedAt] = useState<number | null>(null);
  const [serverLogLoading, setServerLogLoading] = useState(false);
  const serverLogSeqRef = useRef(0);

  const qc = useQueryClient();
  const me = useAuthMe().user;
  const isOwner = me?.isOwner === true;
  const isSupermod = isOwner || me?.role === "supermod";
  // Effective rank used to cap Role… grants. Mirrors backend ROLE_RANK; keep
  // synced if you ever add a new role tier. We treat owner immunity as the
  // top of the ladder regardless of stale `me.role` (cached login row).
  const myRoleRank = isOwner ? ROLE_RANK.owner : ROLE_RANK[(me?.role ?? "guest") as Role];
  const isMod = myRoleRank >= ROLE_RANK.mod;
  // Roles a caller can grant: strictly below their own. Owner is never in the
  // list (set via OWNER_USER_ID env on the backend).
  const grantableRoles = useMemo<Role[]>(
    () => GRANTABLE_ROLE_ORDER.filter((r) => ROLE_RANK[r] < myRoleRank),
    [myRoleRank]
  );

  // Wall-clock tick (drives the "x ago" labels between refetches). Pure UI
  // state — not a TanStack query because there's nothing to fetch.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Each admin feed is its own TanStack query keyed under `queryKeys.admin.*`
  // so a mutation can invalidate exactly the feeds it affects (e.g. ban-user
  // refreshes the action log but leaves the chat-rooms list alone).
  const reportsQuery = useApiQuery<{ ok?: boolean; reports?: Report[] }>({
    queryKey: queryKeys.admin.reports,
    path: "/v1/admin/reports",
    placeholderData: (prev) => prev
  });
  const logsQuery = useApiQuery<{ ok?: boolean; logs?: LogRow[] }>({
    queryKey: queryKeys.admin.actionLog,
    path: "/v1/admin/logs?limit=150",
    placeholderData: (prev) => prev
  });
  const towerRoomsQuery = useApiQuery<{
    ok?: boolean;
    rooms?: TowerRoom[];
    closedSessionCount?: number;
  }>({
    queryKey: queryKeys.admin.sessions,
    path: "/v1/admin/rooms/tower",
    placeholderData: (prev) => prev
  });
  const chatRoomsQuery = useApiQuery<{ ok?: boolean; rooms?: ChatRoomRow[] }>({
    queryKey: [...queryKeys.admin.sessions, "chat"] as const,
    path: "/v1/admin/rooms/chat",
    placeholderData: (prev) => prev
  });
  const directoryQuery = useApiQuery<{ ok?: boolean; principals?: Principal[] }>({
    queryKey: queryKeys.admin.users,
    path: "/v1/admin/principals",
    // Directory rarely changes; keep it cached longer than the other feeds so
    // we don't repaint label rows every few seconds.
    staleTime: 30_000,
    placeholderData: (prev) => prev
  });
  const sanctionsQuery = useApiQuery<SanctionsPayload & { ok?: boolean }>({
    queryKey: queryKeys.admin.sanctions,
    path: "/v1/admin/sanctions",
    placeholderData: (prev) => prev
  });

  const reports = feedFromQuery(reportsQuery, (d) => d.reports ?? []);
  const logs = feedFromQuery(logsQuery, (d) => d.logs ?? []);
  const towerRooms = feedFromQuery(towerRoomsQuery, (d) => d.rooms ?? []);
  const chatRooms = feedFromQuery(chatRoomsQuery, (d) => d.rooms ?? []);
  const sanctions = feedFromQuery(sanctionsQuery, (d) => ({
    bans: d.bans ?? [],
    mutes: d.mutes ?? [],
    kickCooldowns: d.kickCooldowns ?? []
  } as SanctionsPayload));
  const closedSessionCount =
    typeof towerRoomsQuery.data?.closedSessionCount === "number"
      ? towerRoomsQuery.data.closedSessionCount
      : null;
  const directory = useMemo<PrincipalDirectory>(() => {
    const principals = directoryQuery.data?.principals;
    if (!Array.isArray(principals)) return EMPTY_DIRECTORY;
    const byId = new Map<string, Principal>();
    const bridgeIds = new Set<string>();
    for (const p of principals) {
      if (!p?.userId) continue;
      byId.set(p.userId, p);
      if (p.isBridge) bridgeIds.add(p.userId);
    }
    return { byId, bridgeIds };
  }, [directoryQuery.data]);

  const refreshFeed = useCallback(
    (kind: "tower" | "chat" | "reports" | "logs" | "sanctions"): void => {
      const key: readonly unknown[] =
        kind === "tower" ? queryKeys.admin.sessions
        : kind === "chat" ? [...queryKeys.admin.sessions, "chat"]
        : kind === "reports" ? queryKeys.admin.reports
        : kind === "sanctions" ? queryKeys.admin.sanctions
        : queryKeys.admin.actionLog;
      void qc.invalidateQueries({ queryKey: key });
    },
    [qc]
  );

  /**
   * Pull server log deltas (only entries newer than the last `latestSeq` we saw).
   * `reset=true` forces a full reload — used when the operator changes minLevel
   * or hits the manual Refresh button. Truncates the local buffer so memory
   * stays bounded even on a long tail session.
   */
  const fetchServerLogs = useCallback(
    async (reset = false): Promise<void> => {
      setServerLogLoading(true);
      const sinceSeq = reset ? 0 : serverLogSeqRef.current;
      const params = new URLSearchParams({ limit: "300", sinceSeq: String(sinceSeq), level: serverLogMinLevel });
      try {
        // Cursor-based delta endpoint — kept on the imperative ladder
        // (apiCall + setTimeout below) instead of TanStack so the merge
        // semantics stay obvious. Each tail tick advances `serverLogSeqRef`
        // and appends to a bounded buffer; a TanStack query would either
        // refetch the whole window every tick or need a custom merge
        // that's harder to read than this loop.
        const data = await apiCall<{
          ok?: boolean;
          entries?: ServerLogEntry[];
          latestSeq?: number;
          capacity?: number;
        }>(`/v1/admin/server-logs?${params.toString()}`, { method: "GET" });
        setServerLogError(null);
        setServerLogLoadedAt(Date.now());
        const incoming = Array.isArray(data.entries) ? data.entries : [];
        if (typeof data.latestSeq === "number" && data.latestSeq > serverLogSeqRef.current) {
          serverLogSeqRef.current = data.latestSeq;
        }
        setServerLogs((prev) => {
          const base = reset ? [] : prev;
          const merged = base.concat(incoming);
          return merged.length > SERVER_LOG_MAX_RETAINED
            ? merged.slice(merged.length - SERVER_LOG_MAX_RETAINED)
            : merged;
        });
      } catch (e) {
        setServerLogError(e instanceof ApiError && e.unreachable ? "API unreachable" : (e as Error).message);
      } finally {
        setServerLogLoading(false);
      }
    },
    [serverLogMinLevel]
  );

  useEffect(() => {
    void fetchServerLogs(true);
  }, [fetchServerLogs]);

  useEffect(() => {
    if (!serverLogTailing) return;
    const t = window.setInterval(() => void fetchServerLogs(false), SERVER_LOG_TAIL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [serverLogTailing, fetchServerLogs]);

  const derivedUsers = useMemo(
    () => deriveUsers(towerRooms.data, reports.data, logs.data, directory.bridgeIds),
    [towerRooms.data, reports.data, logs.data, directory.bridgeIds]
  );

  // Per-user sanction lookup so each row in the Users panel can:
  //   - hide the Ban / Mute / Kick buttons when the user is already in that
  //     state (issuing another one would just overwrite the existing record)
  //   - surface a Lift button only when there's actually something to lift,
  //     instead of always showing it next to every user.
  // Cooldowns are aggregated across rooms so a single Lift cooldown click can
  // wipe every room cooldown for that identity in one shot.
  const sanctionsByUser = useMemo(() => {
    const map = new Map<string, { ban?: SanctionEntry; mute?: SanctionEntry; cooldowns: KickCooldown[] }>();
    const ensure = (id: string) => {
      let row = map.get(id);
      if (!row) {
        row = { cooldowns: [] };
        map.set(id, row);
      }
      return row;
    };
    for (const ban of sanctions.data?.bans ?? []) ensure(ban.userId).ban = ban;
    for (const mute of sanctions.data?.mutes ?? []) ensure(mute.userId).mute = mute;
    for (const cd of sanctions.data?.kickCooldowns ?? []) ensure(cd.identity).cooldowns.push(cd);
    return map;
  }, [sanctions.data]);

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return derivedUsers;
    return derivedUsers.filter((u) => {
      const label = principalLabel(u.userId, directory).toLowerCase();
      return (
        u.userId.toLowerCase().includes(q) ||
        label.includes(q) ||
        [...u.roles].some((r) => r.includes(q)) ||
        (u.lastAction ?? "").toLowerCase().includes(q)
      );
    });
  }, [derivedUsers, userQuery, directory]);

  // All admin mutations route through a single helper so they share the
  // "set busy id, set feedback, invalidate the affected feeds" plumbing
  // instead of duplicating it five times. The `successFeedback` builder
  // gets the server response so it can include details like "dropped from
  // SFU" vs "cooldown set" for the kick action.
  async function runAction<T>(
    userId: string,
    successFeedback: (data: T) => string,
    fn: () => Promise<T>,
    invalidateFeeds: ReadonlyArray<readonly unknown[]> = [queryKeys.admin.actionLog]
  ): Promise<void> {
    setActionBusyId(userId);
    setActionFeedback(null);
    try {
      const data = await fn();
      setActionFeedback({ userId, text: successFeedback(data), isError: false });
      for (const key of invalidateFeeds) {
        void qc.invalidateQueries({ queryKey: key as unknown[] });
      }
    } catch (e) {
      const msg =
        e instanceof ApiError ? (e.unreachable ? "API unreachable" : e.message)
        : e instanceof Error ? e.message
        : String(e);
      setActionFeedback({ userId, text: msg, isError: true });
    } finally {
      setActionBusyId(null);
    }
  }

  /**
   * Open one of the inline issuance editors (mute / kick / temp-ban /
   * perm-ban / ban-IP). Each editor seeds sensible defaults so the operator
   * can hit Confirm immediately for the common case, and edit duration /
   * reason / room before the API call goes out for everything else.
   *
   * Kick is special: we have to know which active tower room to target. We
   * snapshot the user's current rooms here so the room selector doesn't
   * shuffle if the tower-rooms feed refetches mid-edit.
   */
  function openActionEditor(userId: string, kind: PendingActionKind): void {
    if (!userId) return;
    setActionFeedback(null);
    setRoleEdit(null);
    if (kind === "kick") {
      const inRooms = (towerRooms.data ?? []).filter(
        (r) => r.pilotUserId === userId || r.assignedTowerUserId === userId
      );
      if (inRooms.length === 0) {
        setActionFeedback({ userId, text: "Not in any active tower room.", isError: true });
        return;
      }
      setPendingAction({
        userId,
        kind,
        durationInput: "5",
        reason: "",
        roomName: inRooms[0]!.id,
        availableRooms: inRooms.map((r) => r.id)
      });
      return;
    }
    setPendingAction({
      userId,
      kind,
      durationInput: kind === "mute" ? "60" : kind === "tempban" ? "24" : "",
      reason: "",
      roomName: "",
      availableRooms: []
    });
  }

  /**
   * Submit handler for every issuance editor. Validates the duration field
   * (mute/kick: minutes; tempban/banip: hours; permban: ignored), packs the
   * payload the matching `/v1/admin/*` endpoint expects, and routes through
   * `runAction` so the busy-id, feedback toast and cache invalidations are
   * shared with the rest of the panel.
   */
  async function confirmActionEditor(): Promise<void> {
    if (!pendingAction) return;
    const { userId, kind, durationInput, reason, roomName } = pendingAction;
    const reasonClean = reason.trim() || undefined;

    if (kind === "mute") {
      const minutes = Number.parseInt(durationInput, 10);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setActionFeedback({ userId, text: "Mute duration must be a positive number of minutes.", isError: true });
        return;
      }
      setPendingAction(null);
      await runAction(
        userId,
        () => `Muted ${minutes}m${reasonClean ? ` · ${reasonClean}` : ""}.`,
        () => apiCall<{ ok?: boolean }>("/v1/admin/mute", {
          method: "POST",
          body: JSON.stringify({ userId, durationSeconds: minutes * 60, reason: reasonClean })
        }),
        [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
      );
      return;
    }

    if (kind === "kick") {
      const minutes = Number.parseInt(durationInput, 10);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setActionFeedback({ userId, text: "Kick cooldown must be a positive number of minutes.", isError: true });
        return;
      }
      if (!roomName) {
        setActionFeedback({ userId, text: "Pick a tower room to kick from.", isError: true });
        return;
      }
      setPendingAction(null);
      await runAction(
        userId,
        (data: { livekitRemoved?: boolean }) => {
          const dropped = data?.livekitRemoved ? "dropped from SFU" : "cooldown set (was offline)";
          return `Kicked tower-${roomName} · ${minutes}m · ${dropped}${reasonClean ? ` · ${reasonClean}` : ""}.`;
        },
        () => apiCall<{ ok?: boolean; cooldownSeconds?: number; livekitRemoved?: boolean }>("/v1/admin/kick", {
          method: "POST",
          body: JSON.stringify({
            userId,
            roomName: `tower-${roomName}`,
            durationSeconds: minutes * 60,
            reason: reasonClean
          })
        }),
        [queryKeys.admin.actionLog, queryKeys.admin.sessions, queryKeys.admin.sanctions]
      );
      return;
    }

    if (kind === "tempban") {
      const hours = Number.parseInt(durationInput, 10);
      if (!Number.isFinite(hours) || hours <= 0) {
        setActionFeedback({ userId, text: "Ban duration must be a positive number of hours.", isError: true });
        return;
      }
      setPendingAction(null);
      await runAction(
        userId,
        () => `Banned ${hours}h${reasonClean ? ` · ${reasonClean}` : ""}.`,
        () => apiCall<{ ok?: boolean }>("/v1/admin/ban", {
          method: "POST",
          body: JSON.stringify({ userId, durationSeconds: hours * 3600, reason: reasonClean })
        }),
        [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
      );
      return;
    }

    if (kind === "permban") {
      setPendingAction(null);
      await runAction(
        userId,
        () => `Permanently banned${reasonClean ? ` · ${reasonClean}` : ""}.`,
        () => apiCall<{ ok?: boolean }>("/v1/admin/ban", {
          method: "POST",
          body: JSON.stringify({ userId, reason: reasonClean })
        }),
        [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
      );
      return;
    }

    if (kind === "banip") {
      const hoursRaw = durationInput.trim();
      let durationSeconds: number | undefined;
      if (hoursRaw) {
        const hours = Number.parseInt(hoursRaw, 10);
        if (!Number.isFinite(hours) || hours <= 0) {
          setActionFeedback({ userId, text: "IP-ban hours must be a positive number, or blank for permanent.", isError: true });
          return;
        }
        durationSeconds = hours * 3600;
      }
      const body: Record<string, unknown> = { guestId: userId };
      if (durationSeconds) body.durationSeconds = durationSeconds;
      if (reasonClean) body.reason = reasonClean;
      setPendingAction(null);
      await runAction(
        userId,
        () => `IP ${durationSeconds ? `banned ${Math.floor(durationSeconds / 3600)}h` : "permanently banned"}${reasonClean ? ` · ${reasonClean}` : ""}.`,
        () => apiCall<{ ok?: boolean }>("/v1/admin/ban-ip", {
          method: "POST",
          body: JSON.stringify(body)
        }),
        [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
      );
    }
  }

  async function liftBan(userId: string): Promise<void> {
    if (!userId) return;
    if (typeof window !== "undefined" && !window.confirm(`Lift ban on ${userId}?`)) return;
    await runAction(
      userId,
      (data: { removed?: boolean }) => (data?.removed ? "Ban lifted." : "No active ban."),
      () =>
        apiCall<{ ok?: boolean; removed?: boolean }>("/v1/admin/unban", {
          method: "POST",
          body: JSON.stringify({ userId })
        }),
      [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
    );
  }

  async function liftMute(userId: string): Promise<void> {
    if (!userId) return;
    if (typeof window !== "undefined" && !window.confirm(`Unmute ${userId}?`)) return;
    await runAction(
      userId,
      (data: { removed?: boolean; livekitRestored?: number }) =>
        data?.removed
          ? `Unmuted${data.livekitRestored ? ` · ${data.livekitRestored} room${data.livekitRestored === 1 ? "" : "s"} restored` : ""}.`
          : "No active mute.",
      () =>
        apiCall<{ ok?: boolean; removed?: boolean; livekitRestored?: number }>("/v1/admin/unmute", {
          method: "POST",
          body: JSON.stringify({ userId })
        }),
      [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
    );
  }

  async function liftKickCooldown(userId: string, roomName?: string): Promise<void> {
    if (!userId) return;
    const target = roomName ? `${userId} from ${roomName}` : `every kick cooldown for ${userId}`;
    if (typeof window !== "undefined" && !window.confirm(`Clear ${target}?`)) return;
    await runAction(
      userId,
      (data: { cleared?: number }) =>
        data?.cleared && data.cleared > 0
          ? `Cleared ${data.cleared} cooldown${data.cleared === 1 ? "" : "s"}.`
          : "No cooldown was active.",
      () =>
        apiCall<{ ok?: boolean; cleared?: number }>("/v1/admin/clear-kick-cooldown", {
          method: "POST",
          body: JSON.stringify(roomName ? { userId, roomName } : { userId })
        }),
      [queryKeys.admin.actionLog, queryKeys.admin.sanctions]
    );
  }

  function openRoleEditor(userId: string): void {
    if (!userId || !isMod || grantableRoles.length === 0) return;
    setActionFeedback(null);
    setPendingAction(null);
    // Default to "pilot" if it's grantable, otherwise the highest role this
    // caller is actually allowed to grant. Avoids the editor opening on a
    // value the backend would reject.
    const defaultChoice: Role = grantableRoles.includes("pilot")
      ? "pilot"
      : grantableRoles[grantableRoles.length - 1] ?? "guest";
    setRoleEdit({ userId, choice: defaultChoice });
  }

  async function confirmRoleEdit(): Promise<void> {
    if (!roleEdit || !isMod) return;
    const { userId, choice } = roleEdit;
    if (!grantableRoles.includes(choice)) return;
    setRoleEdit(null);
    await runAction(
      userId,
      () => `Role → ${choice}.`,
      () =>
        apiCall<{ ok?: boolean }>("/v1/admin/role", {
          method: "POST",
          body: JSON.stringify({ userId, role: choice })
        }),
      [queryKeys.admin.actionLog, queryKeys.admin.users]
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Admin</h1>
          <p>
            Operator console. Requires <code>mod</code> or higher.
            Owner is set via <code>OWNER_USER_ID</code> (backend <code>.env</code>); other roles are granted via the Role… button, capped at one tier below your own.
            Feeds auto-load on entry; refresh any card individually.
          </p>
        </div>
      </header>

      <div className="admin-grid">
        <FeedCard
          title="Active tower rooms"
          subtitle={`${towerRooms.data?.length ?? "—"} open · ${closedSessionCount ?? "—"} closed in storage`}
          state={towerRooms}
          onRefresh={() => refreshFeed("tower")}
          nowTick={nowTick}
          empty="No active tower sessions."
          render={(rooms) => (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Session id</th><th>Status</th><th>Pilot</th><th>Tower</th><th>Updated</th></tr>
                </thead>
                <tbody>
                  {rooms.map((room) => (
                    <tr key={room.id}>
                      <td className="mono">{room.id}</td>
                      <td>{room.status}</td>
                      <td className="dim"><PrincipalCell userId={room.pilotUserId} directory={directory} /></td>
                      <td className="dim">{room.assignedTowerUserId ? <PrincipalCell userId={room.assignedTowerUserId} directory={directory} /> : "—"}</td>
                      <td className="dim">{formatAge(room.updatedAt, nowTick)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        />

        <FeedCard
          title="Chat rooms"
          subtitle="Sessions with message traffic"
          state={chatRooms}
          onRefresh={() => refreshFeed("chat")}
          nowTick={nowTick}
          empty="No chat traffic recorded yet."
          render={(rows) => (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Session id</th><th>Messages</th><th>Last message</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.sessionId}>
                      <td className="mono">{row.sessionId}</td>
                      <td>{row.messageCount}</td>
                      <td className="dim">{formatAge(row.lastMessageAt, nowTick)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        />

        <div className="card admin-card-wide">
          <div className="card-head">
            <h2>Users</h2>
            <span className="chat-meta">
              {filteredUsers.length}/{derivedUsers.length} · derived from rooms, reports, logs
            </span>
          </div>
          <input
            type="search"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="Search by user id, role (pilot, tower, reporter, reported, actor), or action…"
            spellCheck={false}
            autoComplete="off"
          />
          {actionFeedback ? (
            <p className={`msg ${actionFeedback.isError ? "error" : "ok"}`} style={{ marginTop: "0.55rem" }}>
              {actionFeedback.userId}: {actionFeedback.text}
            </p>
          ) : null}
          {derivedUsers.length === 0 ? (
            <p style={{ margin: "0.65rem 0 0", color: "var(--muted)", fontSize: "0.88rem" }}>
              No users seen yet. Load some traffic and they'll show up here.
            </p>
          ) : filteredUsers.length === 0 ? (
            <p style={{ margin: "0.65rem 0 0", color: "var(--muted)", fontSize: "0.88rem" }}>
              No users match <code>{userQuery}</code>.
            </p>
          ) : (
            <ul className="admin-users-list">
              {filteredUsers.map((u) => {
                const isGuest = u.userId.startsWith("guest_");
                const busy = actionBusyId === u.userId;
                const label = principalLabel(u.userId, directory);
                const showId = label !== u.userId;
                const userSanctions = sanctionsByUser.get(u.userId);
                const activeBan = userSanctions?.ban;
                const activeMute = userSanctions?.mute;
                const activeCooldowns = userSanctions?.cooldowns ?? [];
                const isPermBan = !!activeBan && !activeBan.expiresAt;
                // Effective auth role of this row's target, used to gate the Role…
                // button so a mod never sees it next to a peer/superior. Falls
                // back to "guest" when the directory hasn't loaded — that keeps
                // the button visible (since guest is always below every actor).
                const targetPrincipal = directory.byId.get(u.userId);
                const targetRole: Role = isGuest
                  ? "guest"
                  : ((targetPrincipal?.role as Role | undefined) ?? "guest");
                const targetRoleRank = ROLE_RANK[targetRole] ?? 0;
                return (
                  <li key={u.userId} className="admin-user-row">
                    <div className="admin-user-meta">
                      <span className="admin-user-id" style={{ fontWeight: 600 }}>{label}</span>
                      {showId ? (
                        <code style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{u.userId}</code>
                      ) : null}
                      <div className="admin-user-roles">
                        {isGuest ? <span className="admin-user-tag tag-guest">Guest</span> : null}
                        {[...u.roles].map((r) => (
                          <span key={r} className={`admin-user-tag tag-${r}`}>{roleLabel(r)}</span>
                        ))}
                        {activeBan ? (
                          <span className="admin-user-tag tag-banned" title={activeBan.reason ?? "no reason given"}>
                            {isPermBan ? "Banned (perm)" : `Banned · ${formatExpiry(activeBan.expiresAt, nowTick)}`}
                          </span>
                        ) : null}
                        {activeMute ? (
                          <span className="admin-user-tag tag-muted" title={activeMute.reason ?? "no reason given"}>
                            Muted · {formatExpiry(activeMute.expiresAt, nowTick)}
                          </span>
                        ) : null}
                        {activeCooldowns.length > 0 ? (
                          <span className="admin-user-tag tag-cooldown" title={activeCooldowns.map((c) => c.roomName).join(", ")}>
                            Cooldown ×{activeCooldowns.length}
                          </span>
                        ) : null}
                      </div>
                      <div className="admin-user-stats">
                        {u.pilotInRooms > 0 ? <span>pilot×{u.pilotInRooms}</span> : null}
                        {u.towerInRooms > 0 ? <span>tower×{u.towerInRooms}</span> : null}
                        {u.reportsBy > 0 ? <span>filed×{u.reportsBy}</span> : null}
                        {u.reportsAgainst > 0 ? <span className="danger">against×{u.reportsAgainst}</span> : null}
                        {u.logHits > 0 ? <span>logs×{u.logHits}</span> : null}
                        <span className="admin-user-last">last {formatAge(u.lastSeenIso, nowTick)}{u.lastAction ? ` · ${u.lastAction}` : ""}</span>
                      </div>
                    </div>
                    <div className="admin-user-actions">
                      {activeMute ? (
                        <button
                          type="button"
                          className="admin-user-lift"
                          onClick={() => void liftMute(u.userId)}
                          disabled={busy}
                          title={`Unmute ${u.userId} now`}
                        >
                          Unmute
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openActionEditor(u.userId, "mute")}
                          disabled={busy}
                          title={`Mute ${u.userId}`}
                        >
                          Mute…
                        </button>
                      )}
                      {activeCooldowns.length > 0 ? (
                        <button
                          type="button"
                          className="admin-user-lift"
                          onClick={() => void liftKickCooldown(u.userId)}
                          disabled={busy}
                          title={`Clear all kick cooldowns for ${u.userId}`}
                        >
                          Clear cooldown
                        </button>
                      ) : u.pilotInRooms + u.towerInRooms > 0 ? (
                        <button
                          type="button"
                          onClick={() => openActionEditor(u.userId, "kick")}
                          disabled={busy}
                          title={`Kick ${u.userId} from a tower room`}
                        >
                          Kick…
                        </button>
                      ) : null}
                      {activeBan ? (
                        (isPermBan && !isSupermod) ? null : (
                          <button
                            type="button"
                            className="admin-user-lift"
                            onClick={() => void liftBan(u.userId)}
                            disabled={busy}
                            title={isPermBan ? `Lift permanent ban on ${u.userId}` : `Lift temp ban on ${u.userId}`}
                          >
                            Unban
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => openActionEditor(u.userId, "tempban")}
                          disabled={busy}
                          title={`Temp-ban ${u.userId}`}
                        >
                          Ban…
                        </button>
                      )}
                      {!activeBan && isSupermod ? (
                        <button
                          type="button"
                          className="admin-user-ban"
                          onClick={() => openActionEditor(u.userId, "permban")}
                          disabled={busy}
                          title={`Permanent ban ${u.userId}`}
                        >
                          Perm ban…
                        </button>
                      ) : null}
                      {isGuest && !activeBan ? (
                        <button
                          type="button"
                          className="admin-user-ban"
                          onClick={() => openActionEditor(u.userId, "banip")}
                          disabled={busy}
                          title={`Ban this guest's IP`}
                        >
                          Ban IP…
                        </button>
                      ) : null}
                      {isMod && !isGuest && grantableRoles.length > 0 && targetRoleRank < myRoleRank ? (
                        <button
                          type="button"
                          onClick={() => openRoleEditor(u.userId)}
                          disabled={busy}
                          title={`Set role for ${u.userId}`}
                        >
                          Role…
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <SanctionsCard
          state={sanctions}
          isSupermod={isSupermod}
          actionBusyId={actionBusyId}
          directory={directory}
          nowTick={nowTick}
          onRefresh={() => refreshFeed("sanctions")}
          onLiftBan={liftBan}
          onLiftMute={liftMute}
          onLiftCooldown={liftKickCooldown}
        />

        <FeedCard
          title="Reports"
          subtitle={reports.data ? `${reports.data.length} on file` : ""}
          state={reports}
          onRefresh={() => refreshFeed("reports")}
          nowTick={nowTick}
          empty="No reports on file."
          render={(rows) => (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>When</th><th>Reporter</th><th>Target</th><th>Session</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {rows.map((rep) => (
                    <tr key={rep.id}>
                      <td className="dim">{formatAge(rep.createdAt, nowTick)}</td>
                      <td className="dim"><PrincipalCell userId={rep.reporterUserId} directory={directory} /></td>
                      <td className="dim">{rep.targetUserId ? <PrincipalCell userId={rep.targetUserId} directory={directory} /> : "—"}</td>
                      <td className="mono dim">{rep.sessionId ?? "—"}</td>
                      <td>{rep.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        />

        <ServerLogCard
          entries={serverLogs}
          minLevel={serverLogMinLevel}
          onMinLevelChange={(lvl) => {
            setServerLogMinLevel(lvl);
            serverLogSeqRef.current = 0;
            setServerLogs([]);
          }}
          filter={serverLogFilter}
          onFilterChange={setServerLogFilter}
          tailing={serverLogTailing}
          onToggleTail={() => setServerLogTailing((t) => !t)}
          onRefresh={() => void fetchServerLogs(true)}
          onClear={() => {
            serverLogSeqRef.current = 0;
            setServerLogs([]);
          }}
          loading={serverLogLoading}
          loadedAt={serverLogLoadedAt}
          error={serverLogError}
          nowTick={nowTick}
        />

        <FeedCard
          title="Logs"
          subtitle={logs.data ? `last ${logs.data.length}` : ""}
          state={logs}
          onRefresh={() => refreshFeed("logs")}
          nowTick={nowTick}
          empty="No log activity."
          render={(rows) => {
            const q = logFilter.trim().toLowerCase();
            const filtered = q
              ? rows.filter((r) => {
                  const meta = r.metadata ? JSON.stringify(r.metadata).toLowerCase() : "";
                  return r.action.toLowerCase().includes(q) || meta.includes(q);
                })
              : rows;
            return (
              <div className="admin-table-wrap">
                <div className="admin-log-filter">
                  <input
                    type="search"
                    placeholder="Filter (e.g. checklist, session.checklist.send)"
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                  />
                  <div className="admin-log-quickfilters">
                    {["checklist", "session.checklist", "session.checklist.send", "session.checklist.ack"].map((p) => (
                      <button
                        type="button"
                        key={p}
                        className={`chip${logFilter === p ? " is-active" : ""}`}
                        onClick={() => setLogFilter(logFilter === p ? "" : p)}
                      >
                        {p}
                      </button>
                    ))}
                    {logFilter ? (
                      <button type="button" className="chip" onClick={() => setLogFilter("")}>clear</button>
                    ) : null}
                  </div>
                  <span className="dim" style={{ fontSize: "0.8rem" }}>
                    {q ? `${filtered.length}/${rows.length} match` : `${rows.length} rows`}
                  </span>
                </div>
                <table className="admin-table">
                  <thead>
                    <tr><th>When</th><th>Actor</th><th>Action</th><th>Meta</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map((log) => (
                      <tr key={log.id}>
                        <td className="dim">{formatAge(log.at, nowTick)}</td>
                        <td className="dim"><PrincipalCell userId={log.actorUserId} directory={directory} /></td>
                        <td>{log.action}</td>
                        <td className="mono dim admin-log-meta">{log.metadata ? JSON.stringify(log.metadata) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        />
      </div>

      {pendingAction ? (
        <ActionModal
          key={`${pendingAction.userId}|${pendingAction.kind}`}
          action={pendingAction}
          targetLabel={principalLabel(pendingAction.userId, directory)}
          busy={actionBusyId === pendingAction.userId}
          onChange={setPendingAction}
          onConfirm={() => void confirmActionEditor()}
          onCancel={() => setPendingAction(null)}
        />
      ) : null}

      {roleEdit ? (
        <RoleModal
          userId={roleEdit.userId}
          targetLabel={principalLabel(roleEdit.userId, directory)}
          choice={roleEdit.choice}
          options={grantableRoles}
          busy={actionBusyId === roleEdit.userId}
          onChange={(choice) => setRoleEdit({ userId: roleEdit.userId, choice })}
          onConfirm={() => void confirmRoleEdit()}
          onCancel={() => setRoleEdit(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Render a userId as `Display Name` with the raw id muted underneath. Bridge
 * identities get a small "(bridge)" badge so a mod can still tell at a glance
 * when a row in Logs / Tower / Reports came from the voice bridge — but the
 * Users panel filters them out entirely (see `deriveUsers`), so the bridge
 * never shows up there as a fake "player".
 */
function PrincipalCell({ userId, directory }: { userId: string; directory: PrincipalDirectory }): JSX.Element {
  const p = directory.byId.get(userId);
  const label = p?.displayName && p.displayName !== userId ? p.displayName : userId;
  const showId = label !== userId;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.15 }}>
      <span style={{ fontWeight: 500 }}>
        {label}
        {p?.isBridge ? (
          <span style={{ marginLeft: "0.35rem", fontSize: "0.7rem", color: "var(--muted)" }}>(bridge)</span>
        ) : null}
      </span>
      {showId ? (
        <code style={{ fontSize: "0.7rem", opacity: 0.65 }}>{userId}</code>
      ) : null}
    </span>
  );
}

type ActionModalProps = {
  action: PendingAction;
  targetLabel: string;
  busy: boolean;
  onChange: (next: PendingAction) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Centred modal dialog rendered when the operator opens any of the issuance
 * editors (mute / kick / temp-ban / perm-ban / ban-IP). Replaces the earlier
 * inline editor so destructive actions get a clear focus moment instead of a
 * second row tucked under the action buttons.
 *
 * UX expectations:
 *   - Backdrop click and Escape both cancel without firing the API call.
 *   - Submits on Enter so a mod can confirm a 60-minute mute with a single
 *     keystroke after clicking Mute….
 *   - Reason is always optional (caps at 500 chars to match the backend
 *     `safeStr(500)` validator) and shown for every kind because operators
 *     consistently asked for it.
 *
 * The modal renders into a `<dialog>` so we get focus trapping and the
 * native top-layer for free without a portal. If the host browser doesn't
 * support `<dialog>` (everything since Safari 15.4 / Firefox 98 does), it
 * still falls back to a modal-shaped element at the same position — just
 * without the focus trap.
 */
function ActionModal({ action, targetLabel, busy, onChange, onConfirm, onCancel }: ActionModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Use the native showModal() API on mount and close() on unmount so the
  // browser handles focus trap, ::backdrop and the top layer. If the API
  // isn't available (very old browser), the dialog is still in the DOM with
  // CSS that draws it as a modal — just without the focus trap.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function" && !el.open) {
      try {
        el.showModal();
      } catch {
        /* already open or unsupported */
      }
    }
    return () => {
      if (el.open) {
        try {
          el.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // Backdrop click closes. The native ::backdrop pseudo-element only
  // receives clicks via the dialog's own click event, so we compare target
  // to currentTarget to tell "clicked the dialog" from "clicked outside".
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`admin-action-modal kind-${action.kind}`}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={handleBackdropClick}
    >
      <ActionEditor
        action={action}
        targetLabel={targetLabel}
        busy={busy}
        onChange={onChange}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </dialog>
  );
}

type RoleModalProps = {
  userId: string;
  targetLabel: string;
  choice: Role;
  options: Role[];
  busy: boolean;
  onChange: (role: Role) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

function RoleModal({
  userId,
  targetLabel,
  choice,
  options,
  busy,
  onChange,
  onConfirm,
  onCancel
}: RoleModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function" && !el.open) {
      try {
        el.showModal();
      } catch {
        /* already open or unsupported */
      }
    }
    return () => {
      if (el.open) {
        try {
          el.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="admin-role-modal"
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={handleBackdropClick}
    >
      <form
        className="admin-role-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <header className="admin-role-form-head">
          <h3>Set role</h3>
          <button type="button" className="admin-role-form-close" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </header>
        <p className="admin-role-form-target">
          {targetLabel}
          {targetLabel !== userId ? <code>{userId}</code> : null}
        </p>
        <label className="admin-role-form-field">
          <span>Role</span>
          <select
            value={choice}
            onChange={(e) => onChange(e.target.value as Role)}
            autoFocus
            disabled={busy}
          >
            {options.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <footer className="admin-role-form-foot">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Set role"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

type ActionEditorProps = {
  action: PendingAction;
  targetLabel: string;
  busy: boolean;
  onChange: (next: PendingAction) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Form body shared by the modal. Pulled out as its own component so the
 * field layout stays testable without dragging the `<dialog>` lifecycle in.
 */
function ActionEditor({ action, targetLabel, busy, onChange, onConfirm, onCancel }: ActionEditorProps): JSX.Element {
  const set = (patch: Partial<PendingAction>): void => onChange({ ...action, ...patch });

  const headline =
    action.kind === "mute" ? "Mute"
    : action.kind === "kick" ? "Kick from room"
    : action.kind === "tempban" ? "Temporary ban"
    : action.kind === "permban" ? "Permanent ban"
    : "IP ban";
  const confirmLabel =
    action.kind === "mute" ? "Apply mute"
    : action.kind === "kick" ? "Kick"
    : action.kind === "tempban" ? "Apply ban"
    : action.kind === "permban" ? "Apply permanent ban"
    : "Apply IP ban";

  // Suffix label inside the duration combo (e.g. "60 minutes") so the unit
  // is visible without a second-line hint cluttering the row.
  const durationUnit =
    action.kind === "mute" || action.kind === "kick" ? "minutes" : "hours";

  const isDestructive = action.kind === "permban" || action.kind === "banip" || action.kind === "tempban";

  return (
    <form
      className={`admin-action-form kind-${action.kind}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onConfirm();
      }}
    >
      <header className="admin-action-form-head">
        <div className="admin-action-form-title">
          <span className="admin-action-form-kind">{headline}</span>
          <span className="admin-action-form-target">{targetLabel}</span>
        </div>
        <button
          type="button"
          className="admin-action-form-close"
          onClick={onCancel}
          disabled={busy}
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="admin-action-form-body">
        {action.kind === "kick" ? (
          <label className="field">
            <span>Room</span>
            <select
              value={action.roomName}
              onChange={(e) => set({ roomName: e.target.value })}
              disabled={busy}
            >
              {action.availableRooms.map((id) => (
                <option key={id} value={id}>tower-{id}</option>
              ))}
            </select>
          </label>
        ) : null}
        {action.kind !== "permban" ? (
          <label className="field field-duration">
            <span>Duration</span>
            <span className="combo">
              <input
                type="number"
                min={action.kind === "banip" ? 0 : 1}
                inputMode="numeric"
                value={action.durationInput}
                placeholder={action.kind === "banip" ? "∞" : ""}
                onChange={(e) => set({ durationInput: e.target.value })}
                disabled={busy}
                autoFocus
              />
              <span className="suffix">{durationUnit}</span>
            </span>
            {action.kind === "banip" ? (
              <span className="hint">blank = permanent</span>
            ) : null}
          </label>
        ) : null}
        <label className="field field-reason">
          <span>Reason {isDestructive ? <em className="dim">(recommended)</em> : null}</span>
          <input
            type="text"
            maxLength={500}
            value={action.reason}
            placeholder={isDestructive ? "Why is this happening? Visible in their moderation history." : "optional"}
            onChange={(e) => set({ reason: e.target.value })}
            disabled={busy}
            autoFocus={action.kind === "permban"}
          />
        </label>
      </div>

      <footer className="admin-action-form-foot">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" disabled={busy}>{confirmLabel}</button>
      </footer>
    </form>
  );
}

type SanctionsCardProps = {
  state: FeedState<SanctionsPayload>;
  isSupermod: boolean;
  actionBusyId: string | null;
  directory: PrincipalDirectory;
  nowTick: number;
  onRefresh: () => void;
  onLiftBan: (userId: string) => void | Promise<void>;
  onLiftMute: (userId: string) => void | Promise<void>;
  onLiftCooldown: (userId: string, roomName?: string) => void | Promise<void>;
};

/**
 * Active-sanctions table. Renders bans, mutes and per-room kick cooldowns
 * as one unified row list so the operator can see — and undo — every
 * enforcement currently in flight from a single card.
 *
 * Each row carries a "Lift" button wired to the matching unban/unmute/
 * clear-cooldown endpoint. Permanent bans hide their Lift button for
 * non-supermods because the backend would 403 the request anyway; surfacing
 * a button that always errors out is worse UX than not showing it.
 */
function SanctionsCard(props: SanctionsCardProps): JSX.Element {
  const {
    state, isSupermod, actionBusyId, directory, nowTick,
    onRefresh, onLiftBan, onLiftMute, onLiftCooldown
  } = props;

  type Row =
    | { rowKey: string; kind: "ban" | "mute"; userId: string; expiresAt?: string; reason?: string; ip?: string }
    | { rowKey: string; kind: "cooldown"; userId: string; roomName: string; expiresAt: string };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const data = state.data;
    if (!data) return out;
    for (const ban of data.bans) {
      out.push({ rowKey: `ban|${ban.userId}`, kind: "ban", userId: ban.userId, expiresAt: ban.expiresAt, reason: ban.reason, ip: ban.ip });
    }
    for (const mute of data.mutes) {
      out.push({ rowKey: `mute|${mute.userId}`, kind: "mute", userId: mute.userId, expiresAt: mute.expiresAt, reason: mute.reason });
    }
    for (const cd of data.kickCooldowns) {
      out.push({ rowKey: `cd|${cd.identity}|${cd.roomName}`, kind: "cooldown", userId: cd.identity, roomName: cd.roomName, expiresAt: cd.expiresAt });
    }
    // Soonest-expiring first so the most "interesting" rows live at the top.
    out.sort((a, b) => {
      const ta = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
      const tb = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
      return ta - tb;
    });
    return out;
  }, [state.data]);

  const totals = useMemo(() => {
    const data = state.data;
    if (!data) return null;
    return `${data.bans.length} ban${data.bans.length === 1 ? "" : "s"} · ${data.mutes.length} mute${data.mutes.length === 1 ? "" : "s"} · ${data.kickCooldowns.length} cooldown${data.kickCooldowns.length === 1 ? "" : "s"}`;
  }, [state.data]);

  return (
    <div className="card admin-feed-card admin-card-wide">
      <div className="card-head">
        <h2>Active sanctions</h2>
        <div className="admin-feed-actions">
          {totals ? <span className="chat-meta">{totals}</span> : null}
          {state.loadedAt ? (
            <span className="chat-meta">{formatAge(new Date(state.loadedAt).toISOString(), nowTick)}</span>
          ) : null}
          <button
            type="button"
            className="admin-feed-refresh"
            onClick={onRefresh}
            disabled={state.loading}
            title="Refresh sanctions"
          >
            {state.loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      {state.error ? (
        <p className="msg error" style={{ marginBottom: "0.55rem" }}>{state.error}</p>
      ) : null}
      {state.data == null && !state.error && state.loading ? (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>Loading…</p>
      ) : state.data && rows.length === 0 ? (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>
          No active sanctions. Bans, mutes and kick cooldowns will appear here.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Target</th>
                <th>Where</th>
                <th>Expires</th>
                <th>Reason</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = actionBusyId === row.userId;
                const isPerm = row.kind === "ban" && !row.expiresAt;
                const canLift = !(isPerm && !isSupermod);
                return (
                  <tr key={row.rowKey}>
                    <td>
                      <span className={`admin-user-tag tag-${row.kind === "cooldown" ? "cooldown" : row.kind === "mute" ? "muted" : "banned"}`}>
                        {row.kind === "cooldown" ? "Cooldown" : row.kind === "mute" ? "Mute" : isPerm ? "Ban (perm)" : "Ban"}
                      </span>
                    </td>
                    <td className="dim"><PrincipalCell userId={row.userId} directory={directory} /></td>
                    <td className="dim mono">
                      {row.kind === "cooldown" ? row.roomName : row.kind === "ban" && row.ip ? `IP ${row.ip}` : "—"}
                    </td>
                    <td className="dim">{formatExpiry(row.expiresAt, nowTick)}</td>
                    <td>{row.kind === "cooldown" ? "—" : row.reason || <span className="dim">—</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      {canLift ? (
                        <button
                          type="button"
                          className="admin-user-lift"
                          disabled={busy}
                          onClick={() => {
                            if (row.kind === "ban") void onLiftBan(row.userId);
                            else if (row.kind === "mute") void onLiftMute(row.userId);
                            else void onLiftCooldown(row.userId, row.roomName);
                          }}
                          title={
                            row.kind === "ban" ? "Lift this ban"
                            : row.kind === "mute" ? "Unmute now (restores publish in active rooms)"
                            : `Clear cooldown for ${row.roomName}`
                          }
                        >
                          Lift
                        </button>
                      ) : (
                        <span className="dim" style={{ fontSize: "0.75rem" }}>supermod only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

type FeedCardProps<T> = {
  title: string;
  subtitle?: string;
  state: FeedState<T>;
  onRefresh: () => void;
  nowTick: number;
  empty: string;
  render: (data: T) => JSX.Element;
};

function FeedCard<T extends ReadonlyArray<unknown>>(props: FeedCardProps<T>): JSX.Element {
  const { title, subtitle, state, onRefresh, nowTick, empty, render } = props;
  const isEmpty = state.data ? state.data.length === 0 : false;
  return (
    <div className="card admin-feed-card">
      <div className="card-head">
        <h2>{title}</h2>
        <div className="admin-feed-actions">
          {subtitle ? <span className="chat-meta">{subtitle}</span> : null}
          {state.loadedAt ? (
            <span className="chat-meta">{formatAge(new Date(state.loadedAt).toISOString(), nowTick)}</span>
          ) : null}
          <button
            type="button"
            className="admin-feed-refresh"
            onClick={onRefresh}
            disabled={state.loading}
            title={`Refresh ${title.toLowerCase()}`}
          >
            {state.loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      {state.error ? (
        <p className="msg error" style={{ marginBottom: "0.55rem" }}>{state.error}</p>
      ) : null}
      {state.data == null && !state.error && state.loading ? (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>Loading…</p>
      ) : null}
      {state.data != null ? (isEmpty ? (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>{empty}</p>
      ) : render(state.data)) : null}
    </div>
  );
}

type ServerLogCardProps = {
  entries: ServerLogEntry[];
  minLevel: ServerLogLevel;
  onMinLevelChange: (level: ServerLogLevel) => void;
  filter: string;
  onFilterChange: (text: string) => void;
  tailing: boolean;
  onToggleTail: () => void;
  onRefresh: () => void;
  onClear: () => void;
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
  nowTick: number;
};

/**
 * "Server logs" card: tails recent backend log lines (pino → in-memory ring
 * buffer) and pretty-prints them with level badges. Auto-polls every 2s while
 * `tailing` is on; pauses immediately when toggled off so an admin can read
 * a frozen window without it scrolling out from under them.
 *
 * Auto-scrolls to the bottom only when the user is already near the bottom,
 * so scrolling up to inspect older lines doesn't keep yanking them away.
 */
function ServerLogCard(props: ServerLogCardProps): JSX.Element {
  const {
    entries, minLevel, onMinLevelChange, filter, onFilterChange,
    tailing, onToggleTail, onRefresh, onClear, loading, loadedAt, error, nowTick
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      if (e.msg.toLowerCase().includes(q)) return true;
      if (e.name && e.name.toLowerCase().includes(q)) return true;
      if (e.meta) {
        try {
          if (JSON.stringify(e.meta).toLowerCase().includes(q)) return true;
        } catch {
          /* circular meta — ignore */
        }
      }
      return false;
    });
  }, [entries, filter]);

  // Snap to the latest line whenever new entries arrive AND the user hasn't
  // scrolled up to read history. Without the stickiness check, manually
  // scrolling up during a hot tail would feel completely unusable.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }

  return (
    <div className="card admin-feed-card admin-card-wide">
      <div className="card-head">
        <h2>Server logs</h2>
        <div className="admin-feed-actions">
          <span className="chat-meta">{filtered.length}/{entries.length} shown</span>
          {loadedAt ? (
            <span className="chat-meta">{formatAge(new Date(loadedAt).toISOString(), nowTick)}</span>
          ) : null}
          <button
            type="button"
            className={`admin-feed-refresh${tailing ? " is-active" : ""}`}
            onClick={onToggleTail}
            title={tailing ? "Pause live tail" : "Resume live tail (polls every 2s)"}
          >
            {tailing ? "Pause" : "Tail"}
          </button>
          <button
            type="button"
            className="admin-feed-refresh"
            onClick={onRefresh}
            disabled={loading}
            title="Reload from buffer"
          >
            {loading ? "…" : "Refresh"}
          </button>
          <button
            type="button"
            className="admin-feed-refresh"
            onClick={onClear}
            title="Clear local view (server buffer keeps 1000 entries)"
          >
            Clear
          </button>
        </div>
      </div>
      {error ? <p className="msg error" style={{ marginBottom: "0.55rem" }}>{error}</p> : null}
      <div className="admin-log-filter">
        <input
          type="search"
          placeholder="Filter (msg / logger name / meta)…"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="admin-log-quickfilters">
          {SERVER_LOG_LEVELS.map((lvl) => (
            <button
              type="button"
              key={lvl}
              className={`chip${minLevel === lvl ? " is-active" : ""}`}
              onClick={() => onMinLevelChange(lvl)}
              title={`Show ${lvl} and above`}
            >
              {lvl}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="server-log-stream"
      >
        {filtered.length === 0 ? (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem", padding: "0.5rem 0.6rem" }}>
            {entries.length === 0
              ? "Waiting for backend log lines…"
              : `No entries match "${filter}" at level ≥ ${minLevel}.`}
          </p>
        ) : (
          filtered.map((entry) => <ServerLogLine key={entry.seq} entry={entry} />)
        )}
      </div>
    </div>
  );
}

function ServerLogLine({ entry }: { entry: ServerLogEntry }): JSX.Element {
  const time = entry.at.length >= 19 ? entry.at.slice(11, 23) : entry.at;
  const meta = entry.meta;
  const metaText = meta && Object.keys(meta).length > 0 ? safeStringifyMeta(meta) : "";
  const levelClass = `server-log-level lvl-${entry.level}`;
  const rowClass = `server-log-line lvl-${entry.level}`;
  // Surface high-signal fields inline so an operator can scan without expanding meta:
  // request id, pid, http context, error class.
  const inlineHints: string[] = [];
  if (entry.name) inlineHints.push(`[${entry.name}]`);
  if (meta && typeof meta.req === "object" && meta.req && "method" in meta.req && "url" in meta.req) {
    const req = meta.req as { method?: unknown; url?: unknown };
    if (typeof req.method === "string" && typeof req.url === "string") {
      inlineHints.push(`${req.method} ${req.url}`);
    }
  }
  if (meta && typeof meta.err === "object" && meta.err && "message" in meta.err) {
    const err = meta.err as { message?: unknown; type?: unknown };
    if (typeof err.message === "string") inlineHints.push(err.message);
    else if (typeof err.type === "string") inlineHints.push(err.type);
  }

  return (
    <div className={rowClass}>
      <span className="server-log-time">{time}</span>
      <span className={levelClass}>{entry.level.toUpperCase()}</span>
      <span className="server-log-msg">
        {entry.msg || <span className="dim">(no message)</span>}
        {inlineHints.length > 0 ? (
          <span className="server-log-hints"> {inlineHints.join(" · ")}</span>
        ) : null}
        {metaText ? <span className="server-log-meta"> {metaText}</span> : null}
      </span>
    </div>
  );
}

/**
 * JSON.stringify with a depth/length guard so a circular or huge meta payload
 * can't tank the React render. Caps the result at ~600 chars to keep one log
 * line readable in the tail view; anything longer is truncated with an ellipsis.
 */
function safeStringifyMeta(meta: Record<string, unknown>): string {
  let out: string;
  try {
    // Strip the noisy req/err siblings we already surface via `inlineHints` so
    // the operator-visible meta line stays focused on the unusual fields.
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === "req" || k === "res" || k === "err") continue;
      cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) return "";
    out = JSON.stringify(cleaned);
  } catch {
    return "";
  }
  if (out.length > 600) return out.slice(0, 597) + "…";
  return out;
}
