import { useEffect, useMemo, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TowerDesk } from "./TowerDesk";
import type { SessionStripEmphasis } from "../components/TowerWall";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { useActiveRoomCached } from "../session/useActiveRoom";
import { apiCall, useApiMutation } from "../query/hooks";
import { queryKeys } from "../query/client";
import { getApiBase } from "../api/client";
import { getStoredUser, userHasCapability } from "../auth/session";

/**
 * Single Tower workspace: role banners plus the monitor wall (`TowerDesk` → `TowerWall`).
 * ACARS, voice, booth, ATIS, tower view, and off-world traffic are wall slots (defaults
 * include them); `/tower/wall` pop-out uses the same slot model. `SESSION_STORAGE_KEY`
 * keeps desks in sync across tabs as the App-level `useActiveRoom` poll updates.
 *
 * The /tower route is gated on `activeRoomOnly` in App.tsx (server-truth "user is
 * pilot or assigned controller of an open session"), so the empty-state branch
 * below is defensive only — it should be unreachable in normal flow, but guarantees
 * we never silently mount the desks against the `dev-shared` bootstrap session if
 * the gate ever races.
 */
function readStoredSessionId(): string | undefined {
  try {
    const v = localStorage.getItem(SESSION_STORAGE_KEY);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function TowerPage(): JSX.Element {
  const initialSessionId = readStoredSessionId();
  const activeRoom = useActiveRoomCached();
  const navigate = useNavigate();

  // Spectator-leave shortcut. Lives here (rather than only in the lobby) so a
  // spectator who deep-linked to /tower has an obvious way out without bouncing
  // through the lobby first. Mutation invalidates active-room so the route
  // guard re-evaluates immediately and punts back to /lobby.
  const leaveSpectatorMutation = useApiMutation<unknown, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall(`/v1/session/${encodeURIComponent(vars.roomId)}`.concat("/leave"), {
        method: "POST"
      }),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onSuccess: () => {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // private mode — the active-room poll will catch up
      }
      navigate("/lobby");
    }
  });

  // Self-release ("Quit tower") for the assigned controller. Goes through the
  // same backend endpoint as a mod kick — `/release-tower` permission-checks
  // the caller. On success the seat is vacated (and a queued replacement, if
  // any, is auto-claimed in the same write); the route guard then punts the
  // ex-controller back to /lobby on the next /me/active-room poll.
  type ReleaseTowerResponse = {
    ok?: boolean;
    releasedUserId?: string | null;
    replacement?: string | null;
    alreadyVacant?: boolean;
  };
  const standDownMutation = useApiMutation<ReleaseTowerResponse, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall<ReleaseTowerResponse>(
        `/v1/session/${encodeURIComponent(vars.roomId)}/release-tower`,
        {
          method: "POST",
          body: JSON.stringify({ assignNext: true })
        }
      ),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom],
    onSuccess: () => {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        /* private mode — active-room poll will catch up */
      }
      navigate("/lobby");
    }
  });

  // Self-serve tower claim. Counterpart to "Quit tower":
  // when the caller is the pilot of a room whose tower seat is currently empty
  // (towerPresent=false) AND they have controller+ rank, this POSTs
  // `/v1/session/:id/claim-tower` so the same account holds the tower seat too.
  // Useful for solo / dev play (be both pilot and tower for your own KSP-launched
  // room, no waiting for the queue to assign someone) and for multi-account
  // controllers who want to fly without giving up their seat to a third party.
  //
  // Backend gates on the `controller:assume` capability so a pure-pilot account
  // can't bypass the queue this way; the button is hidden in that case anyway.
  type ClaimTowerResponse = {
    ok?: boolean;
    assignedTowerUserId?: string;
    alreadyAssigned?: boolean;
  };
  const claimTowerMutation = useApiMutation<ClaimTowerResponse, { roomId: string }>({
    mutationFn: (vars) =>
      apiCall<ClaimTowerResponse>(
        `/v1/session/${encodeURIComponent(vars.roomId)}/claim-tower`,
        {
          method: "POST",
          body: JSON.stringify({})
        }
      ),
    invalidate: [queryKeys.lobby.rooms, queryKeys.me.activeRoom]
  });

  // pagehide / beforeunload safety net: when the controller closes the tab or
  // navigates away externally, fire a one-shot release call so the seat doesn't
  // stay stuck on a phantom user. We use `fetch` with `keepalive: true` instead
  // of `navigator.sendBeacon` because the backend's CSRF guard requires the
  // X-CSRF-Token header on mutating requests (sendBeacon can't set headers).
  // Effect is gated on `myRole === "controller"` so it never fires for pilots
  // (who shouldn't auto-release anything) or spectators (who already auto-leave
  // via the existing `/leave` flow on tab close).
  const myRole = activeRoom?.myRole;
  const activeRoomId = activeRoom?.roomId;
  useEffect(() => {
    if (myRole !== "controller" || !activeRoomId) {
      return;
    }

    const release = (): void => {
      try {
        // Read CSRF cookie inline — same shape as api/client.ts's reader, but
        // duplicated here because we need a sync no-await call inside the
        // pagehide handler (the page is being torn down).
        let csrf = "";
        const all = document.cookie || "";
        for (const part of all.split(/;\s*/)) {
          const eq = part.indexOf("=");
          if (eq < 0) continue;
          if (part.slice(0, eq) === "ksc_tower_csrf") {
            csrf = decodeURIComponent(part.slice(eq + 1));
            break;
          }
        }

        const base = getApiBase();
        const path = `/v1/session/${encodeURIComponent(activeRoomId)}/release-tower`;
        const url = base ? `${base}${path}` : path;

        const headers: Record<string, string> = {
          "Content-Type": "application/json"
        };
        if (csrf) {
          headers["X-CSRF-Token"] = csrf;
        }

        // `keepalive: true` lets the request finish after the page unloads.
        // Errors are intentionally swallowed — the backend is idempotent and
        // a mod can always kick from the lobby if this somehow drops.
        void fetch(url, {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers,
          body: JSON.stringify({ assignNext: true })
        });
      } catch {
        /* page is unloading; nothing useful to do */
      }
    };

    // `pagehide` covers tab close, browser quit, and bfcache navigation in
    // every modern browser. `beforeunload` is a defensive duplicate for
    // legacy paths where pagehide doesn't fire (some embedded webviews).
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    return () => {
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
  }, [myRole, activeRoomId]);

  if (!initialSessionId) {
    return (
      <div className="card">
        <h2>Not in a tower room</h2>
        <p>
          You need to join or create a tower room before the Tower workspace can do anything —
          telemetry, ACARS, and voice are all scoped to a session.
        </p>
        <p>
          <Link to="/lobby">Go to the Lobby</Link> to pick or create one.
        </p>
      </div>
    );
  }

  const isSpectator = activeRoom?.myRole === "spectator";
  const isController = activeRoom?.myRole === "controller";
  const isPilot = activeRoom?.myRole === "pilot";
  const isServerRadioRoom = activeRoom?.roomId.startsWith("ksc-radio-") === true;
  // The "Take controller seat" affordance is shown only when ALL of:
  //   - the caller is the pilot of this room (server says myRole=pilot — note that
  //     a pilot who has *also* self-claimed the tower seat shows up as "pilot" too,
  //     since /me/active-room's role resolution prefers pilot over controller when
  //     both match; the towerPresent flag below is what disambiguates),
  //   - the seat is currently vacant (towerPresent=false),
  //   - the caller has the `controller:assume` capability so the backend won't 403.
  // For a pure-pilot account the button just isn't shown — they should wait for
  // the queue to fill the seat instead.
  const me = useMemo(() => getStoredUser(), []);
  const canSelfServeTower =
    isPilot &&
    activeRoom?.towerPresent === false &&
    userHasCapability(me, "controller:assume");
  const canSpectatorClaimTower =
    isSpectator &&
    activeRoom?.towerPresent === false &&
    userHasCapability(me, "controller:assume");
  // Pilots are not in the booth — that's the whole point of the booth (a
  // spectator-only side-channel that the assigned tower bridges). Hiding the
  // panel here matches the backend's 403 on POST /booth/messages so a pilot
  // never even sees the empty box.
  const showBooth = activeRoom?.myRole !== "pilot";

  type DeskWallStrip = {
    leading: ReactNode;
    trailing: ReactNode;
    emphasis: SessionStripEmphasis | undefined;
  };

  const deskWallStrip: DeskWallStrip = useMemo(() => {
    const empty: DeskWallStrip = { leading: undefined, trailing: undefined, emphasis: undefined };
    if (!activeRoom) return empty;

    if (isController) {
      return {
        leading: (
          <span className="tower-wall__active-tower-label">
            <strong>You are active tower!</strong>
          </span>
        ),
        trailing: (
          <button
            type="button"
            onClick={() => {
              const ok = window.confirm(
                "Quit the tower seat? You'll return to the lobby; the next queued controller takes over if there is one."
              );
              if (ok) standDownMutation.mutate({ roomId: activeRoom.roomId });
            }}
            disabled={standDownMutation.isPending}
            title="Release the tower seat. The pilot stays in the room; the next queued controller is auto-assigned."
          >
            {standDownMutation.isPending ? "Quitting..." : "Quit tower"}
          </button>
        ),
        emphasis: "active-tower"
      };
    }

    const leaveSpectatorBtn = (
      <button
        type="button"
        onClick={() => leaveSpectatorMutation.mutate({ roomId: activeRoom.roomId })}
        disabled={leaveSpectatorMutation.isPending}
        title={isServerRadioRoom ? "Leave this server radio channel" : "Stop spectating and return to the lobby"}
      >
        {leaveSpectatorMutation.isPending ? "Leaving..." : isServerRadioRoom ? "Leave channel" : "Stop spectating"}
      </button>
    );

    const takeSeatBtn = (
      <button
        type="button"
        onClick={() => {
          const ok = window.confirm(
            canSpectatorClaimTower
              ? "Take the controller seat for this room?"
              : "Take the controller seat? You'll be both pilot and tower until you quit."
          );
          if (ok) claimTowerMutation.mutate({ roomId: activeRoom.roomId });
        }}
        disabled={claimTowerMutation.isPending}
        title={
          canSpectatorClaimTower
            ? "Take the empty tower seat for the room you're spectating."
            : "Self-serve: be pilot and tower for this room until you stand down."
        }
      >
        {claimTowerMutation.isPending ? "Claiming..." : "Take controller seat"}
      </button>
    );

    if (isSpectator && canSpectatorClaimTower) {
      return {
        leading: (
          <span className="tower-wall__strip-role-label">
            <strong>No tower</strong>
          </span>
        ),
        trailing: (
          <>
            {leaveSpectatorBtn}
            {takeSeatBtn}
          </>
        ),
        emphasis: "no-tower"
      };
    }

    if (isSpectator) {
      return {
        leading: (
          <span className="tower-wall__strip-role-label">
            <strong>{isServerRadioRoom ? "Tuned" : "Spectating"}</strong>
          </span>
        ),
        trailing: leaveSpectatorBtn,
        emphasis: "spectator"
      };
    }

    if (canSelfServeTower) {
      return {
        leading: (
          <span className="tower-wall__strip-role-label">
            <strong>No tower</strong>
          </span>
        ),
        trailing: takeSeatBtn,
        emphasis: "no-tower"
      };
    }

    return empty;
  }, [
    activeRoom,
    isController,
    isSpectator,
    isServerRadioRoom,
    canSpectatorClaimTower,
    canSelfServeTower,
    standDownMutation.isPending,
    leaveSpectatorMutation.isPending,
    claimTowerMutation.isPending
  ]);

  return (
    <div
      className="tower-workspace tower-workspace--wall"
      style={{ display: "flex", flexDirection: "column", gap: "1rem", flex: 1, minHeight: 0 }}
    >
      <section
        className="tower-workspace-wall"
        aria-label="Tower monitor wall"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        <TowerDesk
          initialSessionId={initialSessionId}
          showBooth={showBooth}
          wallSessionStripLeading={deskWallStrip.leading}
          wallSessionStripTrailing={deskWallStrip.trailing}
          wallSessionStripEmphasis={deskWallStrip.emphasis}
        />
      </section>
    </div>
  );
}
