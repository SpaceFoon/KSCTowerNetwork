import { useSyncExternalStore } from "react";
import { NavLink } from "react-router-dom";
import {
  getVoiceTopBarPtt,
  getVoiceTopBarSnapshot,
  subscribeVoiceTopBar
} from "../voice/sessionVoiceTopBarBridge";

export function TopBarVoiceBrief(): JSX.Element {
  const snap = useSyncExternalStore(subscribeVoiceTopBar, getVoiceTopBarSnapshot, getVoiceTopBarSnapshot);
  const ptt = getVoiceTopBarPtt();

  let status = "Off";
  if (!snap.present) {
    status = "Tower page";
  } else if (snap.reconnecting) {
    status = "Reconnecting…";
  } else if (snap.connecting) {
    status = "Connecting…";
  } else if (snap.connected) {
    if (snap.canSubscribe && !snap.canPublish) {
      status = "Listen-only";
    } else {
      status = "Live";
    }
  } else {
    status = "Idle";
  }

  const showPtt = Boolean(ptt && snap.present && snap.connected && snap.canPublish && snap.pttEnabled);

  return (
    <div className="app-topbar-voice" aria-label="Voice status">
      <span className="app-topbar-voice-label">Voice</span>
      <span className={`app-topbar-voice-status ${snap.connected ? "on" : ""}`}>{status}</span>
      {!snap.present ? (
        <NavLink to="/tower" className="app-topbar-voice-link">
          Open Tower
        </NavLink>
      ) : null}
      {showPtt && ptt ? (
        <button
          type="button"
          className={`app-topbar-voice-ptt ${snap.micHot ? "hot" : ""}`}
          onPointerDown={ptt.onPointerDown}
          onPointerUp={ptt.onPointerUp}
          onPointerCancel={ptt.onPointerUp}
          title="Hold to transmit (same as Settings — T key also works when not typing)"
        >
          PTT
        </button>
      ) : null}
    </div>
  );
}
