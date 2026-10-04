import { type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { userHasCapability, type AuthUser } from "../auth/session";
import { useDmUnread } from "../dm/useDmUnread";
import type { ActiveRoom } from "../session/useActiveRoom";
import { useApiQuery } from "../query/hooks";
import { queryKeys } from "../query/client";
import { AppShellHiddenVoiceHost } from "./AppShellHiddenVoiceHost";
import { TopBarVoiceBrief } from "./TopBarVoiceBrief";
import { displayMhzFromCanonical } from "../lib/displayMhz";

type Props = {
  user: AuthUser;
  /**
   * Server-truth current room from `useActiveRoom`. `null` means the user
   * isn't pilot or assigned controller of any open session — in that case
   * the topbar shows a "Not in a room" hint and the Tower nav link is
   * hidden so people don't click into an empty workspace that silently
   * loads `dev-shared`.
   */
  activeRoom: ActiveRoom | null;
  onSignOut: () => void;
  children: ReactNode;
};

type NavItem = {
  to: string;
  label: string;
  visible: (u: AuthUser, room: ActiveRoom | null) => boolean;
};

/**
 * Tower is gated on `activeRoom`. Without one, the user has nothing to look at
 * — telemetry / hull-cam / chat / strip are all scoped to a session, and the
 * SPA used to silently fall back to `dev-shared` which made voice "look ready"
 * while talking into a permanently-empty LiveKit room.
 *
 * The standalone Wall view used to live here too; it now opens from inside the
 * Tower page via the "Pop out wall" button (which window.open's `/tower/wall`
 * in a new window). Keeping it out of the topbar reduces nav clutter — the
 * wall is a tool you summon, not a destination you navigate to.
 *
 * DMs / Lobby / Admin are independent of having a room and stay visible.
 */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: "/lobby", label: "Lobby", visible: () => true },
  { to: "/dm", label: "DMs", visible: (u) => userHasCapability(u, "chat:dm") },
  // Tower is the per-session workspace (telemetry + chat + voice). Visible only
  // when the caller actually has a session — pilot of the room, or the assigned
  // controller. No room → no Tower link, because the page would otherwise mount
  // with an empty session and silently target the `dev-shared` bootstrap room.
  { to: "/tower", label: "Tower", visible: (_u, room) => room !== null },
  // Per-user settings (display name + personal moderation history). Always
  // visible — even to guests, who may need to see why they're muted/banned.
  { to: "/settings", label: "Settings", visible: () => true },
  { to: "/admin", label: "Admin", visible: (u) => u.isMod },
  // Owner is the server-owner-only console (role grants today; future
  // owner-scoped knobs will live here too). Hidden from everyone else so
  // the surface area is obvious — non-owners never see the link, and a
  // direct visit to /owner is bounced by the route guard in App.tsx.
  { to: "/owner", label: "Owner", visible: (u) => u.isOwner }
];

function roleLabel(role: AuthUser["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "supermod":
      return "Supermod";
    case "mod":
      return "Mod";
    case "controller":
      return "Controller";
    case "pilot":
      return "Pilot";
    case "guest":
      return "Guest";
    default:
      return role;
  }
}

/**
 * The topbar room chip shows the user's *seat* in the current session, not
 * their global rank. The two are separate dimensions (a global-CONTROLLER
 * could in theory be sitting in the pilot seat for a roleplay flight), but
 * reusing the word "PILOT" right next to the global role badge made it look
 * like the system was lying about who the user is — the green "CONTROLLER"
 * badge would sit one inch away from a "PILOT" pill on the same row.
 *
 * Use radio-shorthand `ACFT` (aircraft) / `TWR` (tower) so the chip is
 * unambiguously a *seat label*, distinct from the global role taxonomy of
 * pilot / controller / mod / etc.
 */
function roomRoleLabel(myRole: ActiveRoom["myRole"]): string {
  switch (myRole) {
    case "pilot":
      return "ACFT";
    case "controller":
      return "TWR";
    case "spectator":
      return "LISTEN ONLY";
    default:
      return String(myRole).toUpperCase();
  }
}

/** Long-form description of the seat code used in screen-reader / tooltip text. */
function seatTooltip(myRole: ActiveRoom["myRole"]): string {
  switch (myRole) {
    case "pilot":
      return "Aircraft (you're flying)";
    case "controller":
      return "Tower (you're controlling)";
    case "spectator":
      return "Listening (read-only)";
    default:
      return String(myRole);
  }
}

export function AppShell({ user, activeRoom, onSignOut, children }: Props): JSX.Element {
  const location = useLocation();
  const userLabel = user.displayName ?? user.email ?? user.id;

  // Drive the DMs nav badge from the same `/v1/dm/threads` poll that DmDesk
  // uses (TanStack dedupes on the query key, so this doesn't double the
  // request rate). Only enabled for users who can DM in the first place,
  // matching the visibility rule for the link itself.
  const canDm = userHasCapability(user, "chat:dm");
  const dmUnread = useDmUnread(user.id, canDm);

  // Keep LiveKit joined whenever the user has a session seat, including on
  // /lobby — otherwise KSP MIC_ON / ksp_ptt reaches an empty room (tower tab
  // closed, nobody on /tower) and in-game transmit appears to "do nothing" or
  // flake until they open Tower.
  const mountVoiceOffTower = activeRoom && !location.pathname.startsWith("/tower");

  return (
    <>
      <header className="app-topbar" role="banner">
        <div className="app-topbar-inner">
          <div className="app-topbar-brand" aria-label="KSC Tower Network">
            <span className="app-topbar-brand-mark" aria-hidden>
              <img
                src="/brand-mark.svg?v=5"
                alt=""
                className="app-topbar-brand-mark-img"
                draggable={false}
              />
            </span>
            <span className="app-topbar-brand-text">Kerbal Tower Network</span>
          </div>

          <nav className="app-topbar-nav" aria-label="Primary">
            {NAV_ITEMS.filter((item) => item.visible(user, activeRoom)).map((item) => {
              const badge = item.to === "/dm" ? dmUnread.totalUnread : 0;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => "app-topbar-link" + (isActive ? " active" : "")}
                  aria-label={
                    badge > 0
                      ? `${item.label} (${badge} unread)`
                      : undefined
                  }
                >
                  {item.label}
                  {badge > 0 ? (
                    <span className="app-topbar-link-badge" aria-hidden>
                      {badge > 99 ? "99+" : badge}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </nav>

          {activeRoom ? <TopBarVoiceBrief /> : null}

          <div className="app-topbar-user">
            {activeRoom ? (
              <span
                className="app-topbar-session"
                title={`In room ${activeRoom.roomName}${activeRoom.frequencyMhz ? ` on ${displayMhzFromCanonical(activeRoom.frequencyMhz)} MHz` : ""} — your seat: ${seatTooltip(activeRoom.myRole)} (${activeRoom.roomId})`}
                aria-label={`In room ${activeRoom.roomName}, seat: ${seatTooltip(activeRoom.myRole)}`}
              >
                <span className="app-topbar-session-label">{roomRoleLabel(activeRoom.myRole)}</span>
                <strong className="app-topbar-session-name">{activeRoom.roomName}</strong>
                {activeRoom.frequencyMhz ? (
                  <code className="app-topbar-session-freq">
                    {displayMhzFromCanonical(activeRoom.frequencyMhz)} MHz
                  </code>
                ) : null}
              </span>
            ) : (
              <span
                className="app-topbar-session app-topbar-session-empty"
                title="You are not in any tower room. Pick or create one in the Lobby."
                aria-label="Not in a tower room"
              >
                <span className="app-topbar-session-label">NO ROOM</span>
                <NavLink to="/lobby" className="app-topbar-session-link">
                  Go to Lobby
                </NavLink>
              </span>
            )}
            <span
              className={`app-topbar-role role-${user.role}`}
              title={`Role: ${user.role}`}
              aria-label={`Role ${user.role}`}
            >
              {roleLabel(user.role)}
            </span>
            <span className="app-topbar-userid" title={user.id}>{userLabel}</span>
            <button type="button" className="app-topbar-signout" onClick={onSignOut}>
              {user.isGuest ? "Leave" : "Sign out"}
            </button>
          </div>
        </div>
      </header>
      {mountVoiceOffTower ? <AppShellHiddenVoiceHost /> : null}
      {activeRoom ? <SessionCountdownBox sessionId={activeRoom.roomId} /> : null}
      <main className="layout app-shell">{children}</main>
    </>
  );
}

function SessionCountdownBox({ sessionId }: { sessionId: string }): JSX.Element | null {
  type SessionRes = {
    ok?: boolean;
    session?: { countdownStartsAt?: string; countdownLengthSec?: number };
  };

  const q = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });

  const startsAt = q.data?.session?.countdownStartsAt;
  const lengthSec = q.data?.session?.countdownLengthSec;
  if (!startsAt || lengthSec == null) return null;

  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs)) return null;
  const remainingSec = Math.ceil((startMs + lengthSec * 1000 - Date.now()) / 1000);
  if (remainingSec < -3) return null;

  const label =
    remainingSec > 0
      ? `T-${String(remainingSec).padStart(2, "0")}`
      : remainingSec >= -3
        ? "T-00"
        : null;
  if (!label) return null;

  return (
    <div
      className="atc-countdown-clock running global-countdown-box"
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  );
}
