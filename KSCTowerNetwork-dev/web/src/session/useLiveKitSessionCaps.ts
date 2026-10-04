import { useCallback, useEffect } from "react";
import { ApiError, apiCall, useApiQuery, useQueryClient } from "../query/hooks";
import { queryKeys } from "../query/client";

export type LiveKitCapsState =
  | { kind: "idle" }
  | { kind: "empty" }
  | { kind: "loading" }
  | {
      kind: "ok";
      roomName: string;
      canPublish: boolean;
      canSubscribe: boolean;
    }
  | { kind: "error"; status: number; message: string };

type TokenBody = {
  ok?: boolean;
  roomName?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
};

/**
 * Loads LiveKit token metadata for the session (no voice connect) so the UI can
 * show publish vs listen-only.
 *
 * Implemented as a TanStack query so the same caps are shared across any
 * component that asks (e.g. tower wall + voice panel both call this for the
 * same session — only one HTTP request goes out, both render off the cache).
 *
 * Auto-refreshes every `pollIntervalMs` (default 10 s) while the document is
 * visible. The endpoint is a POST (it mints a token), but it's idempotent
 * from the caller's POV — same session = same caps until the session ends.
 *
 * Returns the caps as a discriminated union for backwards compat with the
 * older imperative shape; the consuming UI hasn't changed.
 */
export function useLiveKitSessionCaps(
  sessionId: string,
  options: { pollIntervalMs?: number; enabled?: boolean } = {}
): {
  state: LiveKitCapsState;
  refresh: () => Promise<void>;
} {
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const capsEnabled = options.enabled !== false;
  const trimmed = sessionId.trim();
  const qc = useQueryClient();

  const q = useApiQuery<TokenBody>({
    queryKey: queryKeys.session.livekitCaps(trimmed),
    queryFn: ({ signal }) =>
      apiCall<TokenBody>(`/v1/session/${encodeURIComponent(trimmed)}/livekit-token`, {
        method: "POST",
        body: "{}",
        signal
      }),
    enabled: !!trimmed && capsEnabled,
    refetchInterval: trimmed && capsEnabled && pollIntervalMs > 0 ? pollIntervalMs : false,
    refetchIntervalInBackground: false,
    staleTime: pollIntervalMs > 0 ? Math.max(pollIntervalMs - 1_000, 1_000) : 5_000,
    placeholderData: (prev) => prev,
    // Caps don't really change for a stable session; one refetch on focus is plenty.
    refetchOnWindowFocus: true
  });

  // Refetch immediately when the tab becomes visible — caps may have been
  // revoked while we were backgrounded (admin kicked the user, session ended).
  useEffect(() => {
    if (!trimmed || !capsEnabled) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        void qc.invalidateQueries({ queryKey: queryKeys.session.livekitCaps(trimmed) });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [qc, trimmed, capsEnabled]);

  const refresh = useCallback(async () => {
    if (!trimmed || !capsEnabled) return;
    await qc.invalidateQueries({ queryKey: queryKeys.session.livekitCaps(trimmed) });
  }, [qc, trimmed, capsEnabled]);

  let state: LiveKitCapsState;
  if (!trimmed) {
    state = { kind: "empty" };
  } else if (q.isLoading && !q.data) {
    state = { kind: "loading" };
  } else if (q.error) {
    const err = q.error as ApiError;
    state = { kind: "error", status: err.status, message: err.message };
  } else if (q.data) {
    const d = q.data;
    if (d.roomName != null && typeof d.canPublish === "boolean" && typeof d.canSubscribe === "boolean") {
      state = {
        kind: "ok",
        roomName: d.roomName,
        canPublish: d.canPublish,
        canSubscribe: d.canSubscribe
      };
    } else {
      state = { kind: "error", status: 200, message: "Unexpected LiveKit response shape" };
    }
  } else {
    state = { kind: "idle" };
  }

  return { state, refresh };
}
