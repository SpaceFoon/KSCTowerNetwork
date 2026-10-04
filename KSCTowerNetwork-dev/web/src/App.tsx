import { useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import {
  clearStoredSession,
  userHasCapability,
  type AuthUser
} from "./auth/session";
import { useAuthMe } from "./auth/useAuthMe";
import { AppShell } from "./components/AppShell";
import { AdminDesk } from "./pages/AdminDesk";
import { ChartsPage } from "./pages/ChartsPage";
import { DmDesk } from "./pages/DmDesk";
import { LandingPage } from "./pages/LandingPage";
import { LobbyPage } from "./pages/LobbyPage";
import { LoginPage } from "./pages/LoginPage";
import { OwnerDesk } from "./pages/OwnerDesk";
import { SettingsPage } from "./pages/SettingsPage";
import { TowerPage } from "./pages/TowerPage";
import { TowerWallPage } from "./pages/TowerWallPage";
import { TowerWallRowPopoutPage } from "./pages/TowerWallRowPopoutPage";
import { useActiveRoom } from "./session/useActiveRoom";
import { useQueryClient } from "./query/hooks";
import { queryKeys } from "./query/client";

export default function App(): JSX.Element {
  const auth = useAuthMe();
  // Login flow stashes the user via setStoredUser; we mirror it here so the
  // post-login render flips to the authed shell without waiting for the next
  // /v1/auth/me refetch. Once the query revalidates, `auth.user` overrides.
  const [optimisticUser, setOptimisticUser] = useState<AuthUser | null>(null);
  const user = auth.user ?? optimisticUser;

  const qc = useQueryClient();

  // Server-truth "is the user actually in a tower room?". Drives the topbar
  // pill, the Tower / Wall nav links, AND the route guard for `/tower` and
  // `/tower/wall`. Skipped while signed out so we don't 401-poll.
  const activeRoomState = useActiveRoom(user !== null);

  function signOut(): void {
    void clearStoredSession();
    setOptimisticUser(null);
    // Wipe the entire query cache so the next sign-in doesn't render with
    // the previous user's data while queries refetch.
    qc.clear();
  }

  if (auth.isLoading && !user) {
    return (
      <div className="layout">
        <div className="card">
          <p>Checking session...</p>
        </div>
      </div>
    );
  }

  function shell(children: ReactNode): JSX.Element {
    if (!user) return <Navigate to="/login" replace />;
    return (
      <AppShell user={user} activeRoom={activeRoomState.activeRoom} onSignOut={signOut}>
        {children}
      </AppShell>
    );
  }

  /** Pages that need a real participant identity (voice/plugin/controller). Guests bounce to lobby. */
  function memberOnly(children: ReactNode): JSX.Element {
    if (!user) return <Navigate to="/login" replace />;
    if (user.isGuest) return <Navigate to="/lobby" replace />;
    return shell(children);
  }

  function modOnly(children: ReactNode): JSX.Element {
    if (!user) return <Navigate to="/login" replace />;
    if (!user.isMod) return <Navigate to="/lobby" replace />;
    return shell(children);
  }

  function ownerOnly(children: ReactNode): JSX.Element {
    if (!user) return <Navigate to="/login" replace />;
    // /owner hosts grants and other owner-scoped server controls. Anyone
    // below owner gets bounced to /lobby — even mods, who have their own
    // console at /admin.
    if (!user.isOwner) return <Navigate to="/lobby" replace />;
    return shell(children);
  }

  /**
   * Pages that only make sense when the user is actually in a tower room
   * (telemetry/chat/voice are session-scoped). When the server says "no active
   * room", we punt to /lobby instead of letting the page silently mount on the
   * `dev-shared` bootstrap session — which is how voice "looked ready" while
   * talking into nothing in earlier builds.
   *
   * `loaded === false` means the very first poll hasn't returned yet; we render
   * a thin "checking..." placeholder so we don't flicker /tower → /lobby on a
   * legit deep-link.
   */
  function activeRoomOnly(
    children: ReactNode,
    extra?: (u: AuthUser) => boolean
  ): JSX.Element {
    if (!user) return <Navigate to="/login" replace />;
    if (user.isGuest) return <Navigate to="/lobby" replace />;
    if (extra && !extra(user)) return <Navigate to="/lobby" replace />;
    if (!activeRoomState.loaded) {
      return shell(
        <div className="card">
          <p>Checking your tower room...</p>
        </div>
      );
    }
    if (!activeRoomState.activeRoom) return <Navigate to="/lobby" replace />;
    return shell(children);
  }

  return (
    <>
      {auth.apiOffline ? (
        <div className="api-offline-global" role="status">
          <span className="api-offline-global-text">
            Cannot reach the tower API — showing the last known session.
          </span>
        </div>
      ) : null}
      <Routes>
        <Route
          path="/login"
          element={
            user ? (
              <Navigate to="/lobby" replace />
            ) : (
              <LoginPage
                onLogin={(nextUser) => {
                  setOptimisticUser(nextUser);
                  // Force /v1/auth/me to refetch immediately so the cached
                  // capability set is the live one before the user navigates.
                  void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
                }}
              />
            )
          }
        />
        <Route
          path="/lobby"
          element={shell(user ? <LobbyPage user={user} onRoomChanged={activeRoomState.refresh} /> : null)}
        />
        <Route path="/dm" element={memberOnly(user ? <DmDesk user={user} /> : null)} />
        {/* /tower is the per-session workspace (telemetry + chat + voice). Gated
         * on the server-truth "you are pilot or assigned controller of an open
         * session" — without that, the page would silently mount on the
         * `dev-shared` bootstrap session and voice would "look ready" while
         * talking into an empty LiveKit room. Spectator mode is parked until
         * there's a real read-only role on the backend; see REAL_TOWER_ROADMAP.md. */}
        <Route path="/tower" element={activeRoomOnly(<TowerPage />)} />
        <Route
          path="/tower/wall"
          element={activeRoomOnly(<TowerWallPage />, (u) => userHasCapability(u, "controller:assume"))}
        />
        <Route path="/tower/wall/row" element={activeRoomOnly(<TowerWallRowPopoutPage />)} />
        <Route
          path="/charts"
          element={
            import.meta.env.DEV
              ? shell(user ? <ChartsPage /> : null)
              : <Navigate to="/lobby" replace />
          }
        />
        <Route path="/chat" element={<Navigate to="/tower" replace />} />
        <Route path="/voice" element={<Navigate to="/tower" replace />} />
        {/* Legacy room URLs from before the unified /tower workspace. */}
        <Route path="/room/:roomId" element={<Navigate to="/tower" replace />} />
        {/* /settings is per-user: edit display name + view personal moderation
         * history (active bans/mutes + recent kicks). Available to everyone
         * who has a session, including guests, since a guest with a temp ban
         * still has the right to see why. */}
        <Route
          path="/settings"
          element={shell(
            user ? (
              <SettingsPage
                user={user}
                onUserUpdated={(next) => {
                  setOptimisticUser(next);
                  void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
                }}
              />
            ) : null
          )}
        />
        <Route path="/admin" element={modOnly(<AdminDesk />)} />
        <Route path="/owner" element={ownerOnly(<OwnerDesk />)} />
        {/* Public landing page is the default unauth landing spot. Authed users
         * still bounce to /lobby because once they're in, the landing page is
         * just a redirect away from where they actually wanted to be. */}
        <Route
          path="/"
          element={
            user ? (
              <Navigate to="/lobby" replace />
            ) : (
              <LandingPage
                onLogin={(nextUser) => {
                  setOptimisticUser(nextUser);
                  void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
                }}
              />
            )
          }
        />
        <Route path="*" element={<Navigate to={user ? "/lobby" : "/"} replace />} />
      </Routes>
    </>
  );
}
