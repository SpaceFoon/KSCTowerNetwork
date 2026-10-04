/**
 * Quick-tune presets for the in-game radio ◀ / ▶ arrows and public site metadata.
 * Keep in sync with `RadioQuickPreset` defaults in `TowerRadioGui.cs` (plugin).
 */
export type RadioQuickPreset = {
  id: string;
  label: string;
  /** Canonical six-digit form "NNN.NNN" (MHz). */
  frequencyMhz: string;
};

export const RADIO_QUICK_PRESETS: readonly RadioQuickPreset[] = [
  { id: "twr", label: "TWR", frequencyMhz: "122.000" },
  { id: "gnd", label: "GND", frequencyMhz: "121.700" },
  /** Dedicated KSC ATIS slot (maps to LiveKit `freq-atis-*` when per-frequency channels ship). */
  { id: "atis", label: "ATIS", frequencyMhz: "128.250" },
  { id: "emrg", label: "EMRG", frequencyMhz: "121.500" }
];
