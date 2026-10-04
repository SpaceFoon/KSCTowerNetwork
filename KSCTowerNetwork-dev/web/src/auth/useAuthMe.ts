import { useEffect } from "react";
import { getStoredToken } from "../api/client";
import { useApiQuery } from "../query/hooks";
import { queryKeys } from "../query/client";
import {
  authUserFromResponse,
  clearStoredSession,
  getStoredUser,
  setStoredUser,
  type AuthUser
} from "./session";

type MeResponse = { ok?: boolean; user?: unknown };

/**
 * The canonical "who am I?" hook. Used at App boot to validate any cached
 * session, and surfaced for any component that wants the live user record.
 *
 * Behavior:
 *  - Skipped entirely when there's no stored bearer token AND no cookie hint.
 *    (Without a token the request would just 401 forever.) The App-level
 *    cookie path will surface a `Sign in` screen instead of polling.
 *  - On 200: keeps localStorage in sync so a hard refresh feels instant
 *    (the SPA can render the cached user before the request returns).
 *  - On 401/403/etc (auth lapsed): clears local session and returns `null`.
 *  - On unreachable API: keeps the cached user so the UI doesn't flicker the
 *    user out of their session every time the network blips.
 *
 * The data is the resolved `AuthUser` (or `null` if not signed in). Refetches
 * on window focus, so a tab that's been backgrounded for a long time picks
 * up role / capability changes (e.g. a mod was just promoted) without a
 * manual refresh.
 */
export function useAuthMe(): {
  user: AuthUser | null;
  isLoading: boolean;
  apiOffline: boolean;
} {
  const hasToken = !!getStoredToken();
  // We always run the query when there's any chance we're authed (token
  // present, OR we have a cached user from a previous cookie-only session).
  const enabled = hasToken || !!getStoredUser();

  const q = useApiQuery<MeResponse>({
    queryKey: queryKeys.auth.me,
    path: "/v1/auth/me",
    enabled,
    // Keep role/capability changes reasonably fresh; voice caps depend on this.
    staleTime: 10_000,
    refetchInterval: 0
  });

  // Sync server-truth into localStorage so a hard refresh paints the cached
  // user immediately and only swaps it after the request returns.
  useEffect(() => {
    if (!enabled) {
      setStoredUser(null);
      return;
    }
    if (q.data) {
      const next = authUserFromResponse(q.data.user);
      setStoredUser(next);
    } else if (q.error && !q.error.unreachable) {
      // Auth-style failure (not a network blip) — wipe the local session so
      // the UI flips to the login screen on the next render.
      void clearStoredSession();
    }
  }, [enabled, q.data, q.error]);

  const cached = getStoredUser();
  const live = q.data ? authUserFromResponse(q.data.user) : null;

  return {
    // Prefer the freshly-fetched user; fall back to the cached one while the
    // first request is in flight or while offline.
    user: live ?? cached,
    isLoading: enabled && q.isLoading,
    apiOffline: !!q.error?.unreachable
  };
}
