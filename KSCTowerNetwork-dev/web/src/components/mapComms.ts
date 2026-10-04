/**
 * Comms chip helpers for tower telemetry. Lives outside `KerbinTowerMap.tsx` so
 * that file can satisfy React Fast Refresh (no non-component `commsStatus` export).
 */
export type CommsStatus = "na" | "blackout" | "link" | "home";

export type CommsStatusInput = {
  commNetAvailable?: boolean;
  commLink?: boolean;
  commLinkHome?: boolean;
} | null | undefined;

export function commsStatus(t: CommsStatusInput): CommsStatus {
  if (!t || !t.commNetAvailable) return "na";
  if (!t.commLink) return "blackout";
  return t.commLinkHome ? "home" : "link";
}

export function commsStatusLabel(s: CommsStatus, signal: number | undefined): string {
  const sig =
    signal != null && Number.isFinite(signal)
      ? ` · ${(Math.max(0, Math.min(1, signal)) * 100).toFixed(0)}%`
      : "";
  switch (s) {
    case "home":
      return `LINK to KSC${sig}`;
    case "link":
      return `LINK via relay${sig}`;
    case "blackout":
      return "NO LINK · BLACKOUT";
    default:
      return "DSN n/a";
  }
}
