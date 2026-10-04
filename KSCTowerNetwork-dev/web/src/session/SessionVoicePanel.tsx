type Props = {
  sessionId: string;
  onSessionIdChange: (id: string) => void;
  onHandOff: () => void;
  handOffBusy: boolean;
};

export function SessionVoicePanel(props: Props): JSX.Element {
  const { sessionId, onSessionIdChange, onHandOff, handOffBusy } = props;

  async function copySessionId(): Promise<void> {
    const id = sessionId.trim();
    if (!id || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="session-panel">
      <div className="session-panel-row">
        <label htmlFor="session-voice-sid" className="session-panel-label">
          Session id
        </label>
        <div className="session-panel-input-row">
          <input
            id="session-voice-sid"
            value={sessionId}
            onChange={(e) => onSessionIdChange(e.target.value)}
            placeholder="(joined room id)"
            spellCheck={false}
            autoComplete="off"
            readOnly
          />
          <button type="button" onClick={() => void copySessionId()} disabled={!sessionId.trim()}>
            Copy
          </button>
        </div>
      </div>

      <div className="session-panel-actions">
        <button
          type="button"
          onClick={onHandOff}
          disabled={handOffBusy || !sessionId.trim()}
          title="Hand off this session to the next eligible tower operator"
        >
          {handOffBusy ? "Handing off…" : "Hand off tower"}
        </button>
      </div>
    </div>
  );
}
