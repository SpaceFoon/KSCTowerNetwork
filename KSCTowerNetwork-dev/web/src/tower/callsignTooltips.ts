/**
 * Native `title` strings for callsign labels/values across the tower web UI.
 * Session callsign (lobby) vs pilot/craft label (KSP plugin) are easy to confuse;
 * tooltips spell out how each is set.
 */

/** Tower views: strips, map craft details, active pilots, radar blips, off-world list, etc. */
export const CALLSIGN_DISPLAY_HELP =
  "Lobby assigns the ATC session callsign for this tower room. In KSP, set a per-vessel callsign when the Tower plugin prompts (telemetry beacon on), or each craft falls back to your Tower account callsign from login.";

/** Signup / Settings — account default used when a vessel has no override. */
export const ACCOUNT_CALLSIGN_HELP =
  "Shown in the lobby and voice. Use letters, numbers, and spaces. Each KSP craft can still use its own Tower callsign when the beacon prompts.";
