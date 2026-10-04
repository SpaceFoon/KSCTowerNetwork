import { useEffect, useState } from "react";
import { TowerWall } from "../components/TowerWall";
import { SESSION_STORAGE_KEY } from "../session/constants";
import { useActiveRoomCached } from "../session/useActiveRoom";

/**
 * Standalone /wall page. The actual customizable monitor grid is the shared
 * `<TowerWall/>` component (also mounted at the top of TowerDesk). This page is
 * just the route shell — it sources the session id from `localStorage` (the same
 * key TowerDesk's Active Pilots tracker writes to) and live-mirrors changes from
 * other tabs via the `storage` event.
 *
 * The route is gated on `activeRoomOnly` in App.tsx, so reaching this component
 * implies a real session — no `dev-shared` fallback (which used to silently
 * back-fill an empty bootstrap session and make the wall "look fine" while
 * pointing at nothing). On the off chance the storage value clears mid-session
 * (manual purge, sign-out from another tab) we render a thin empty state
 * instead of pretending we have data.
 */
function readSessionId(): string {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function TowerWallPage(): JSX.Element {
  const activeRoom = useActiveRoomCached();
  /** Cross-tab only: `storage` does not fire in the tab that wrote `localStorage`. */
  const [storageSession, setStorageSession] = useState(readSessionId);
  const showBoothSlot = activeRoom?.myRole !== "pilot";

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== SESSION_STORAGE_KEY) return;
      setStorageSession(e.newValue?.trim() ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Prefer TanStack's `/me/active-room` cache (same-tab) over storage hints so
  // room switches and post-join writes visible to App sync here without a storage event.
  const sessionId = (activeRoom?.roomId?.trim() || storageSession).trim();

  if (!sessionId) {
    return (
      <div className="card">
        <h2>Wall</h2>
        <p>You are not in a tower room. Pick or create one in the Lobby.</p>
      </div>
    );
  }

  return (
    <div className="tower-wall-route">
      <TowerWall sessionId={sessionId} persistKey="tower-wall-page" showBoothSlot={showBoothSlot} />
    </div>
  );
}
