import { useEffect, useState } from "react";
import type { AuthUser } from "../auth/session";
import { userHasCapability } from "../auth/session";
import { apiCall, useApiMutation } from "../query/hooks";

const KINDS = ["TAKEOFF", "LANDING", "TAXI", "HOLD_SHORT", "GO_AROUND"] as const;

export type SessionClearances = Partial<Record<(typeof KINDS)[number], "cleared" | "violation">>;

type Props = {
  sessionId: string;
  user: AuthUser;
  clearances?: SessionClearances;
  expectedLandingRunway?: string | null;
  onChanged?: () => void;
};

export function ClearancePanel({
  sessionId,
  user,
  clearances = {},
  expectedLandingRunway = "",
  onChanged
}: Props): JSX.Element | null {
  const canControl = userHasCapability(user, "controller:assume");
  const [rwyDraft, setRwyDraft] = useState(expectedLandingRunway ?? "");

  useEffect(() => {
    setRwyDraft(expectedLandingRunway ?? "");
  }, [expectedLandingRunway]);

  const setClearance = useApiMutation<unknown, { clearance: string; status: string }>({
    mutationFn: (body) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/clearance`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => onChanged?.()
  });

  const saveExpected = useApiMutation<unknown, { runway: string | null }>({
    mutationFn: (body) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/expected-runway`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => onChanged?.()
  });

  if (!canControl) return null;

  return (
    <div className="tower-clearance-panel">
      <h3 className="tower-clearance-head">Clearances</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Approve / deny for RP — no physics enforcement. Green = cleared, red = violation.
      </p>
      <table className="tower-clearance-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {KINDS.map((kind) => {
            const st = clearances[kind];
            return (
              <tr key={kind}>
                <td>
                  <code>{kind}</code>
                </td>
                <td>
                  {!st ? (
                    <span className="muted">—</span>
                  ) : st === "cleared" ? (
                    <span style={{ color: "var(--ok)" }}>cleared</span>
                  ) : (
                    <span style={{ color: "var(--danger)" }}>violation</span>
                  )}
                </td>
                <td className="tower-clearance-actions">
                  <button
                    type="button"
                    disabled={setClearance.isPending}
                    onClick={() => setClearance.mutate({ clearance: kind, status: "cleared" })}
                  >
                    Approve
                  </button>{" "}
                  <button
                    type="button"
                    disabled={setClearance.isPending}
                    onClick={() => setClearance.mutate({ clearance: kind, status: "violation" })}
                  >
                    Deny
                  </button>{" "}
                  <button
                    type="button"
                    className="muted"
                    disabled={setClearance.isPending}
                    onClick={() => setClearance.mutate({ clearance: kind, status: "neutral" })}
                  >
                    Clear
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="tower-expected-rwy" style={{ marginTop: "0.75rem" }}>
        <label>
          Expected landing runway{" "}
          <input
            value={rwyDraft}
            onChange={(e) => setRwyDraft(e.target.value)}
            placeholder="09"
            maxLength={8}
            style={{ width: "5rem", marginLeft: "0.35rem" }}
          />
        </label>{" "}
        <button
          type="button"
          disabled={saveExpected.isPending}
          onClick={() => saveExpected.mutate({ runway: rwyDraft.trim() || null })}
        >
          Save
        </button>
      </div>
    </div>
  );
}
