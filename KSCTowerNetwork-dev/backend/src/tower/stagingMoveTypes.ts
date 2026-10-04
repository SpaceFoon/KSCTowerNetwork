import { z } from "zod";

const STAGING_MOVE_PRESET_IDS = [
  "ksc_ga_ramp",
  "ksc_main_apron",
  "ksc_runway09_hold",
  "ksc_sph_outside",
  "ksc_vab_south"
] as const;

export type StagingMovePresetId = (typeof STAGING_MOVE_PRESET_IDS)[number];

const LABELS: Record<StagingMovePresetId, string> = {
  ksc_ga_ramp: "KSC — GA ramp (east lawn)",
  ksc_main_apron: "KSC — main apron / terminal area",
  ksc_runway09_hold: "KSC — hold short / 09 approach end",
  ksc_sph_outside: "KSC — SPH exterior pad",
  ksc_vab_south: "KSC — VAB south gate"
};

/** Named KSC ramp / apron spots tower can push to the pilot client (plugin maps id → lat/lon/heading). */
export const STAGING_MOVE_PRESETS: ReadonlyArray<{ id: StagingMovePresetId; label: string }> =
  STAGING_MOVE_PRESET_IDS.map((id) => ({ id, label: LABELS[id] }));

export const stagingMoveIssueSchema = z.object({
  preset: z.enum(STAGING_MOVE_PRESET_IDS)
});

export type StagingMoveRequest = {
  preset: StagingMovePresetId;
  label: string;
  issuedAt: string;
  issuedByUserId: string;
};
