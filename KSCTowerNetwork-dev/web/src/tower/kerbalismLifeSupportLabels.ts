/**
 * Kerbalism life-support resource keys (`kerbalism.lifeSupport` in telemetry).
 * Unknown keys still render under their raw id.
 */
export const LIFE_SUPPORT_LABEL: Record<string, string> = {
  food: "Food",
  water: "Water",
  oxygen: "O₂",
  nitrogen: "N₂",
  atmosphere: "Atmosphere",
  wasteAtmosphere: "Waste atmo",
  carbonDioxide: "CO₂"
};

/** Kerbin-day length (s) for storm duration when plugin only sends `durationSec`. */
export const HOME_DAY_SECONDS_FALLBACK = 21600;
