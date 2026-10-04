import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";

type Props = {
  sessionId: string;
  squawk?: string;
  callsign?: string;
};

const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

/**
 * Compact ATC-style chip row showing the room id, callsign, and assigned squawk. Squawk
 * turns red when it matches a real-world emergency code (hijack/radio-fail/general).
 */
export function SessionHeader({ sessionId, squawk, callsign }: Props): JSX.Element {
  const isEmergency = squawk ? EMERGENCY_SQUAWKS.has(squawk) : false;
  return (
    <div className="atc-session-header">
      <span className="atc-session-room">
        Room <code>{sessionId}</code>
      </span>
      {callsign ? (
        <span className="atc-session-callsign" title={CALLSIGN_DISPLAY_HELP}>
          {callsign}
        </span>
      ) : null}
      {squawk ? (
        <span
          className={"atc-session-squawk " + (isEmergency ? "emergency" : "")}
          title={isEmergency ? "Emergency squawk!" : "Squawk"}
        >
          SQ {squawk}
        </span>
      ) : null}
    </div>
  );
}
