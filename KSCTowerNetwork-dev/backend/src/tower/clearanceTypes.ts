import { z } from "zod";

export const CLEARANCE_KINDS = ["TAKEOFF", "LANDING", "TAXI", "HOLD_SHORT", "GO_AROUND"] as const;
export type ClearanceKind = (typeof CLEARANCE_KINDS)[number];

export const CLEARANCE_DISPOSITIONS = ["cleared", "violation", "neutral"] as const;
export type ClearanceDisposition = (typeof CLEARANCE_DISPOSITIONS)[number];

export type SessionClearances = Partial<Record<ClearanceKind, "cleared" | "violation">>;

export const clearancePostSchema = z.object({
  clearance: z.enum(CLEARANCE_KINDS),
  status: z.enum(CLEARANCE_DISPOSITIONS)
});

export const expectedRunwaySchema = z.object({
  runway: z.string().max(8).nullable()
});

export const runwayOccupancyPostSchema = z.object({
  bodyName: z.string().min(1).max(64),
  runwayId: z.string().min(1).max(16),
  occupied: z.boolean()
});
