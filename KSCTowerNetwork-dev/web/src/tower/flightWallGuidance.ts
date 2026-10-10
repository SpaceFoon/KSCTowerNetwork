import type { Telemetry } from "../components/KerbinTowerMap";

export function compassPoint(degrees: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((degrees % 360 + 360) % 360) / 45) % 8]!;
}

export function flightWallGuidance(t: Telemetry, distanceKm: number, bearing: number, nowMs: number, staleAfterMs = 15_000) {
  const fresh = t.sampleUnixMs != null && Number.isFinite(t.sampleUnixMs) && nowMs - t.sampleUnixMs >= -5_000 && nowMs - t.sampleUnixMs < staleAfterMs;
  const direction = compassPoint(bearing);
  if (!fresh) return { title: "Last known position", detail: "Waiting for fresh flight telemetry.", state: "stale", direction };
  if (t.situation === "LANDED" || t.situation === "PRELAUNCH" || t.situation === "SPLASHED") {
    return { title: t.situation === "PRELAUNCH" ? "Ready on the ground" : "On the surface", detail: `${distanceKm.toFixed(1)} km ${direction} of the airfield.`, state: "ground", direction };
  }
  if (t.landing || t.onApproach) return { title: "On approach", detail: `Inbound for ${t.targetRunway || t.activeRunway || "the airfield"}. Look ${direction}.`, state: "inbound", direction };
  if (t.situation === "ORBITING" || t.situation === "ESCAPING") return { title: "Above the atmosphere", detail: `${t.bodyName || "Body"} · ${t.situation.toLowerCase()}.`, state: "orbit", direction };
  // Compare track heading with the bearing from the airfield, rather than guessing from distance alone.
  if (t.heading == null || !Number.isFinite(t.heading)) return { title: "In flight", detail: `Look ${direction} of the airfield.`, state: "flight", direction };
  const radial = Math.cos((t.heading - bearing) * Math.PI / 180);
  if (distanceKm < 1.5) return { title: "Near the airfield", detail: `Look ${direction}; the craft is within 1.5 km.`, state: "near", direction };
  if (radial < -0.25) return { title: "Heading toward us", detail: `Look ${direction}. The craft is heading toward the airfield.`, state: "inbound", direction };
  if (radial > 0.25) return { title: "Flying away", detail: `Look ${direction}. The craft is heading away from the airfield.`, state: "outbound", direction };
  return { title: "Passing across", detail: `Look ${direction}. The craft is crossing the airfield’s bearing.`, state: "passing", direction };
}
