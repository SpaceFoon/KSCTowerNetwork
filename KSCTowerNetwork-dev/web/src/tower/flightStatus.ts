/**
 * One-line flight / link summary for session tiles (desk + wall).
 * Uses telemetry health + optional `situation` from the game plugin.
 */
export type FlightStatusTone = "ok" | "warn" | "alert";

export type FlightStatusInput = {
  telemetry: {
    situation?: string;
    craftName?: string;
    lat?: number;
    lon?: number;
  } | null;
  telemetryHealth: { state: string } | null;
  countdownRequest?: { at?: string } | null;
  takeoffRequest?: { at?: string } | null;
};

function deriveBaseFlightStatus(input: FlightStatusInput): { label: string; tone: FlightStatusTone } {
  const { telemetry: t, telemetryHealth: h } = input;
  if (h?.state === "vessel_dead") return { label: "Vessel lost", tone: "alert" };

  const situation = (t?.situation ?? "").toUpperCase();
  if (situation === "LANDED" || situation === "SPLASHED" || situation === "PRELAUNCH") {
    return { label: "On surface", tone: "ok" };
  }
  if (situation.length > 0) return { label: "In flight", tone: "ok" };

  const hasTelemetryTrace = t != null && (t.craftName != null || t.lat != null || t.lon != null);
  if (hasTelemetryTrace) return { label: "Receiving data", tone: "ok" };

  if (h?.state === "live" && !t) return { label: "Awaiting vessel data", tone: "warn" };
  return { label: "Idle", tone: "warn" };
}

function withOverlay(prefix: string, baseLabel: string): string {
  return `${prefix} · ${baseLabel}`;
}

export function deriveGameLinkLabel(telemetryHealth: { state?: string } | null | undefined): string {
  switch (telemetryHealth?.state) {
    case "stale":
      return "Disconnected";
    case "paused":
      return "Paused";
    case "warp":
      return "Warping";
    case "scene_left":
      return "Not in flight";
    case "vessel_switch":
      return "Switching vessel";
    case "beacon_off":
      return "Beacon off";
    case "vessel_dead":
      return "Vessel lost";
    default:
      return "Connected";
  }
}

export function deriveFlightStatusPill(input: FlightStatusInput): { label: string; tone: FlightStatusTone } {
  const { telemetryHealth: h, countdownRequest: req, takeoffRequest: to } = input;
  const base = deriveBaseFlightStatus(input);

  if (h?.state === "scene_left") return { label: "Left flight / reverted", tone: "warn" };
  if (h?.state === "vessel_switch") return { label: withOverlay("Switching vessel", base.label), tone: "warn" };
  if (h?.state === "paused") return { label: withOverlay("Paused", base.label), tone: "warn" };
  if (h?.state === "stale") return { label: "Game link lost", tone: "alert" };
  if (h?.state === "beacon_off") return { label: "Beacon off", tone: "warn" };
  if (h?.state === "warp") return { label: withOverlay("Warping", base.label), tone: "warn" };

  // Pending pilot pings before generic `situation` — on the runway KSP often reports
  // PRELAUNCH / FLYING, which would otherwise hide takeoff / countdown request pills.
  if (to?.at) return { label: "Takeoff request", tone: "warn" };
  if (req?.at) return { label: "Countdown request", tone: "warn" };
  return base;
}
