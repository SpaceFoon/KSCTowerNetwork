export type LandingQuality = "GOOD" | "HARD" | "OFF_CENTER";

/** Tier-only landing assessment from last short-final sample (no numeric leaderboard). */
export function landingQualityFromSamples(
  alignErrDeg: number | undefined,
  verticalSpeedMs: number | undefined
): LandingQuality {
  const align = alignErrDeg ?? 99;
  const vs = verticalSpeedMs ?? 0;
  const absVs = Math.abs(vs);
  if (align > 8 || absVs > 6) return "OFF_CENTER";
  if (align > 4 || absVs > 3.5) return "HARD";
  return "GOOD";
}
