/**
 * Hardcoded pilot/controller checklist templates.
 *
 * v1 only. Editable templates (per-controller, per-mission-pack) are explicitly out of scope —
 * the data model would need a `checklist_templates` table and admin UI. For now, dropping new
 * items into this file is the migration path; existing `sessions.checklist_state` rows simply
 * ignore unknown ids and the new ones will appear unchecked.
 */

export type ChecklistSide = "pilot" | "controller";

/**
 * Optional auto-tick rule. Mirrors backend `ChecklistAutoRule`. When `expr` matches the
 * current telemetry sample, the backend ticks the pilot-side item automatically. The
 * grammar is a single comparison (`field op literal`) with `op` in `== != > >= < <=` and
 * `literal` in true|false|number. See backend repository.ts > evaluateAutoRule.
 */
export interface ChecklistAutoRule {
  kind: "telemetry";
  expr: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  autoRule?: ChecklistAutoRule;
}

export interface ChecklistPhase {
  id: string;
  title: string;
  pilot: ChecklistItem[];
  controller: ChecklistItem[];
}

/**
 * Compare two phase arrays to surface a "what's actually changing if I send this" preview.
 * `current` is the session's effective phases; `next` is what the user is about to apply.
 * Item moves from one phase to another count as `addedItems` + `removedItems` since their
 * id may differ.
 */
export interface ChecklistDiff {
  addedPhases: string[];
  removedPhases: string[];
  renamedPhases: Array<{ id: string; from: string; to: string }>;
  addedItems: Array<{ phaseTitle: string; side: ChecklistSide; label: string }>;
  removedItems: Array<{ phaseTitle: string; side: ChecklistSide; label: string }>;
  renamedItems: Array<{ phaseTitle: string; side: ChecklistSide; from: string; to: string }>;
}

export function diffChecklistPhases(
  current: ChecklistPhase[],
  next: ChecklistPhase[]
): ChecklistDiff {
  const out: ChecklistDiff = {
    addedPhases: [],
    removedPhases: [],
    renamedPhases: [],
    addedItems: [],
    removedItems: [],
    renamedItems: []
  };
  const curById = new Map(current.map((p) => [p.id, p]));
  const nextById = new Map(next.map((p) => [p.id, p]));

  for (const p of next) {
    if (!curById.has(p.id)) out.addedPhases.push(p.title);
  }
  for (const p of current) {
    if (!nextById.has(p.id)) out.removedPhases.push(p.title);
  }
  for (const p of next) {
    const prev = curById.get(p.id);
    if (prev && prev.title !== p.title) {
      out.renamedPhases.push({ id: p.id, from: prev.title, to: p.title });
    }
  }

  const sides: ChecklistSide[] = ["pilot", "controller"];
  for (const p of next) {
    const prev = curById.get(p.id);
    const phaseTitle = p.title;
    if (!prev) {
      // entire phase is new -> all items are adds
      for (const side of sides) for (const it of p[side]) out.addedItems.push({ phaseTitle, side, label: it.label });
      continue;
    }
    for (const side of sides) {
      const prevById = new Map(prev[side].map((it) => [it.id, it]));
      const nextSideById = new Map(p[side].map((it) => [it.id, it]));
      for (const it of p[side]) {
        const before = prevById.get(it.id);
        if (!before) out.addedItems.push({ phaseTitle, side, label: it.label });
        else if (before.label !== it.label) {
          out.renamedItems.push({ phaseTitle, side, from: before.label, to: it.label });
        }
      }
      for (const it of prev[side]) {
        if (!nextSideById.has(it.id)) out.removedItems.push({ phaseTitle, side, label: it.label });
      }
    }
  }
  for (const p of current) {
    if (nextById.has(p.id)) continue;
    for (const side of sides) {
      for (const it of p[side]) out.removedItems.push({ phaseTitle: p.title, side, label: it.label });
    }
  }
  return out;
}

export function isEmptyDiff(d: ChecklistDiff): boolean {
  return (
    d.addedPhases.length === 0 &&
    d.removedPhases.length === 0 &&
    d.renamedPhases.length === 0 &&
    d.addedItems.length === 0 &&
    d.removedItems.length === 0 &&
    d.renamedItems.length === 0
  );
}

/**
 * Phase IDs and item IDs MUST stay in lockstep with:
 *   - backend/src/services/defaultChecklist.ts (DEFAULT_CHECKLIST_PHASES)
 *   - PluginSrc/TowerChecklistDefaults.cs (TowerChecklistDefaults.Build)
 * so existing sessions.checklist_state rows continue to identify the same items
 * across the web modal, the in-game GUI, and the backend default response.
 */
export const CHECKLIST_PHASES: ChecklistPhase[] = [
  {
    id: "before-start",
    title: "Before Engine Start",
    pilot: [
      { id: "bs_parking_brake", label: "Parking brake — SET" },
      { id: "bs_battery", label: "Battery charge — CHECK" },
      { id: "bs_fuel", label: "Fuel quantity — CHECK" },
      { id: "bs_staging", label: "Staging — CHECK" },
      { id: "bs_flight_plan", label: "Flight plan — FILED" },
      { id: "bs_lights", label: "Lights — ON" },
      { id: "bs_flaps", label: "Flaps — RETRACTED" },
      { id: "bs_gear", label: "Landing gear — DOWN / GREEN" },
      { id: "bs_throttle", label: "Throttle — IDLE" }
    ],
    controller: [
      { id: "ct_bs_atis", label: "Issue ATIS / weather" },
      { id: "ct_bs_clearance", label: "Acknowledge flight plan / clearance" }
    ]
  },
  {
    id: "before-takeoff",
    title: "Before Takeoff",
    pilot: [
      { id: "bt_atc", label: "ATC — ADVISE" },
      { id: "bt_cabin", label: "Cabin — READY" },
      { id: "bt_flt_controls", label: "Flight controls — TEST" },
      { id: "bt_trim", label: "Trim — AS REQUIRED" },
      { id: "bt_flaps", label: "Flaps — AS REQUIRED" },
      { id: "bt_spoiler", label: "Spoiler — RETRACTED" },
      { id: "bt_auto_speed_brake", label: "Auto speed brake — OFF" },
      { id: "bt_brakes_force", label: "Brake force — SET" },
      { id: "bt_parking_brake", label: "Parking brake — SET" },
      { id: "bt_lights", label: "Lights — ON" },
      { id: "bt_nav_radio", label: "NAV radio — SET" },
      { id: "bt_thrust_limit", label: "Thrust limit — AS REQUIRED" },
      { id: "bt_engine_mode", label: "Engine mode — AS REQUIRED" },
      { id: "bt_engine_gimbal", label: "Engine gimbal — AS REQUIRED" },
      { id: "bt_sas", label: "SAS — ON, STAB" },
      { id: "bt_avionics", label: "Avionics — CHECK" },
      { id: "bt_apu", label: "APU — ON" },
      { id: "bt_briefing", label: "Briefing — CONFIRMED" }
    ],
    controller: [
      { id: "ct_bt_taxi", label: "Clear to taxi via … to runway …" },
      { id: "ct_bt_lineup", label: "Line up and wait" },
      { id: "ct_bt_clear_to", label: "Cleared for takeoff" }
    ]
  },
  {
    id: "after-takeoff",
    title: "After Takeoff",
    pilot: [
      { id: "at_apu", label: "APU — OFF" },
      { id: "at_lights", label: "Lights — OFF" },
      { id: "at_gear", label: "Landing gear — UP" },
      { id: "at_flaps", label: "Flaps — RETRACTED" }
    ],
    controller: [
      { id: "ct_at_handoff_dep", label: "Hand off to departure" },
      { id: "ct_at_traffic", label: "Issue traffic advisories" }
    ]
  },
  {
    id: "descent",
    title: "Descent",
    pilot: [
      { id: "ds_auto_speed_brake", label: "Auto speed brake — ARM" },
      { id: "ds_apu", label: "APU — ON" },
      { id: "ds_lights", label: "Lights — ON" },
      { id: "ds_nav_radio", label: "NAV radio — SET" },
      { id: "ds_briefing", label: "Briefing — CONFIRMED" }
    ],
    controller: [
      { id: "ct_ds_descend", label: "Descend when ready" },
      { id: "ct_ds_handoff_app", label: "Hand off to approach" }
    ]
  },
  {
    id: "approach-landing",
    title: "Approach / Landing",
    pilot: [
      { id: "al_cabin", label: "Cabin — READY" },
      { id: "al_trim", label: "Trim — AS REQUIRED" },
      { id: "al_flaps", label: "Flaps — AS REQUIRED" },
      { id: "al_gear", label: "Landing gear — DOWN / GREEN" },
      { id: "al_radar_alt", label: "Radar altitude — MDA / DH SET" },
      { id: "al_nav_radio", label: "NAV radio — SET" },
      { id: "al_thrust_limit", label: "Thrust limit — AS REQUIRED" },
      { id: "al_engine_mode", label: "Engine mode — AS REQUIRED" },
      { id: "al_engine_gimbal", label: "Engine gimbal — AS REQUIRED" }
    ],
    controller: [
      { id: "ct_al_clear_approach", label: "Cleared approach runway …" },
      { id: "ct_al_handoff_twr", label: "Hand off to tower" },
      { id: "ct_al_clear_land", label: "Cleared to land" }
    ]
  },
  {
    id: "after-landing",
    title: "After Landing",
    pilot: [
      { id: "la_sas", label: "SAS — OFF" },
      { id: "la_parking_brake", label: "Parking brake — OFF" },
      { id: "la_spoiler", label: "Spoiler — RETRACTED" },
      { id: "la_auto_speed_brake", label: "Auto speed brake — OFF" }
    ],
    controller: [
      { id: "ct_la_taxi_park", label: "Taxi to parking" },
      { id: "ct_la_handoff_gnd", label: "Hand off to ground" }
    ]
  },
  {
    id: "parking",
    title: "Parking",
    pilot: [
      { id: "pk_recovery", label: "Vessel recovery call — AS REQUIRED" },
      { id: "pk_staging", label: "Staging — CHECK" },
      { id: "pk_engine", label: "Engine — SHUTDOWN" },
      { id: "pk_throttle", label: "Throttle — IDLE" },
      { id: "pk_trim", label: "Trim — RESET / CHECK" },
      { id: "pk_lights", label: "Lights — OFF" },
      { id: "pk_parking_brake", label: "Parking brake — SET" }
    ],
    controller: [
      { id: "ct_pk_recovery", label: "Acknowledge vessel recovery" },
      { id: "ct_pk_close", label: "Close strip / log session" }
    ]
  }
];
