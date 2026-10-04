import { VoiceDesk } from "../pages/VoiceDesk";

/**
 * Keeps a single LiveKit voice session alive while the user browses non-/tower
 * routes (DMs, settings) but still holds an active session seat. Hidden off
 * screen so audio elements stay attached to the document.
 */
export function AppShellHiddenVoiceHost(): JSX.Element {
  return (
    <div className="app-shell-hidden-voice-host" aria-hidden>
      <VoiceDesk embedInWall />
    </div>
  );
}
