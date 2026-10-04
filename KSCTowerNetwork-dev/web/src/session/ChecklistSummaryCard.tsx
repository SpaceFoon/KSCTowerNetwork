import { useMemo } from "react";
import { CHECKLIST_PHASES, type ChecklistPhase } from "./checklists";
import { computeCounts, type ChecklistSendRecord, type ChecklistState } from "./ChecklistModal";

type Props = {
  /** Effective phase override for this session. Falls back to the hardcoded template. */
  phases?: ChecklistPhase[];
  state?: ChecklistState;
  /** Most recent send-to-tower receipt for the session, used for an "awaiting ack" badge. */
  latestSend?: ChecklistSendRecord | null;
  onOpen: () => void;
};

/**
 * Compact inline card shown where the giant checklist used to live. Surfaces "n/m done"
 * for each side and opens the full modal on click. Same sentinel-style summary the user
 * sees in the modal header — kept in lockstep via `computeCounts`.
 */
export function ChecklistSummaryCard({ phases, state, latestSend, onOpen }: Props): JSX.Element {
  const effective = phases && phases.length > 0 ? phases : CHECKLIST_PHASES;
  const counts = useMemo(() => computeCounts(effective, state), [effective, state]);
  const isCustom = !!(phases && phases.length > 0);
  const total = counts.pilotTotal + counts.ctrlTotal;
  const done = counts.pilotDone + counts.ctrlDone;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const sendPending = !!(latestSend && !latestSend.ackUserId);

  return (
    <button type="button" className="atc-checklist-summary" onClick={onOpen} aria-label="Open checklists">
      <div className="atc-checklist-summary-head">
        <strong>Checklists</strong>
        <span className="atc-checklist-summary-meta">
          {isCustom ? "Custom" : "Default"} - {done}/{total} done ({percent}%)
          {sendPending ? <span className="atc-tag atc-tag-pending"> awaiting ack</span> : null}
        </span>
      </div>
      <div className="atc-checklist-summary-row">
        <span>Pilot</span>
        <ProgressBar done={counts.pilotDone} total={counts.pilotTotal} />
        <span className="room-meta">
          {counts.pilotDone}/{counts.pilotTotal}
        </span>
      </div>
      <div className="atc-checklist-summary-row">
        <span>Controller</span>
        <ProgressBar done={counts.ctrlDone} total={counts.ctrlTotal} />
        <span className="room-meta">
          {counts.ctrlDone}/{counts.ctrlTotal}
        </span>
      </div>
      <span className="atc-checklist-summary-cta">Open checklists</span>
    </button>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }): JSX.Element {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="atc-checklist-summary-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="atc-checklist-summary-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
