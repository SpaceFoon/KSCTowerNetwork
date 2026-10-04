import { useQuery } from "@tanstack/react-query";
import type { AuthUser } from "../auth/session";
import { userHasCapability } from "../auth/session";
import { apiCall, useApiMutation } from "../query/hooks";
import { queryKeys } from "../query/client";

export type StagingMoveRequest = {
  preset: string;
  label: string;
  issuedAt: string;
  issuedByUserId: string;
};

type PresetRow = { id: string; label: string };

type Props = {
  sessionId: string;
  user: AuthUser;
  stagingMoveRequest?: StagingMoveRequest | null;
  onChanged?: () => void;
  /** Wall slot: show pending + help text even when the viewer is not the assigned controller. */
  forceVisible?: boolean;
};

export function StagingMovePanel({
  sessionId,
  user,
  stagingMoveRequest,
  onChanged,
  forceVisible = false
}: Props): JSX.Element | null {
  const canControl = userHasCapability(user, "controller:assume");

  const presetsQuery = useQuery({
    queryKey: queryKeys.tower.stagingMovePresets(),
    queryFn: async () => {
      const j = await apiCall<{ ok: true; presets: PresetRow[] }>("/v1/tower/staging-move-presets");
      return j.presets;
    },
    enabled: canControl,
    staleTime: 60 * 60 * 1000
  });

  const issue = useApiMutation<unknown, { preset: string }>({
    mutationFn: (body) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/staging-move`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => onChanged?.()
  });

  const clear = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/staging-move/clear`, {
        method: "POST",
        body: "{}"
      }),
    onSuccess: () => onChanged?.()
  });

  if (!canControl) {
    if (!forceVisible) return null;
    return (
      <div className="tower-clearance-panel tower-staging-move-panel tower-staging-move-panel--readonly">
        <h3 className="tower-clearance-head">Ramp / taxi</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Only the assigned controller can send ramp positions to the pilot.
        </p>
        {stagingMoveRequest ? (
          <p className="tower-staging-pending mono" style={{ fontSize: "0.88rem", margin: "0.5rem 0 0" }}>
            <strong>Pending:</strong> {stagingMoveRequest.label}{" "}
            <span className="muted">({stagingMoveRequest.preset})</span>
          </p>
        ) : (
          <p className="muted" style={{ fontSize: "0.88rem", margin: "0.5rem 0 0" }}>
            No ramp position pending.
          </p>
        )}
      </div>
    );
  }

  const presets = presetsQuery.data ?? [];

  return (
    <div className="tower-clearance-panel tower-staging-move-panel">
      <h3 className="tower-clearance-head">Ramp / taxi</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Send a named KSC ramp or apron spot; echoed to the pilot on telemetry for the game client (e.g.
        Vessel Mover).
      </p>
      {stagingMoveRequest ? (
        <p className="tower-staging-pending mono" style={{ fontSize: "0.88rem", marginBottom: "0.65rem" }}>
          <strong>Pending:</strong> {stagingMoveRequest.label}{" "}
          <span className="muted">({stagingMoveRequest.preset})</span>
        </p>
      ) : (
        <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.65rem" }}>
          No ramp position pending.
        </p>
      )}
      <div className="tower-staging-preset-grid">
        {presetsQuery.isLoading ? (
          <span className="muted">Loading presets…</span>
        ) : presetsQuery.isError ? (
          <span className="tone-danger">Could not load presets.</span>
        ) : (
          presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="tower-staging-preset-btn"
              disabled={issue.isPending}
              title={p.label}
              onClick={() => issue.mutate({ preset: p.id })}
            >
              {p.label}
            </button>
          ))
        )}
      </div>
      <div style={{ marginTop: "0.65rem" }}>
        <button
          type="button"
          className="muted"
          disabled={clear.isPending || !stagingMoveRequest}
          onClick={() => clear.mutate(undefined)}
        >
          Clear ramp request
        </button>
      </div>
    </div>
  );
}
