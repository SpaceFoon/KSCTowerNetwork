import type { ChecklistPhaseDef } from "./repository";

/**
 * Hardcoded fallback checklist used when a session has no `checklistPhases` override
 * and a participant hasn't loaded a saved template. Kept in sync by hand with the
 * web copy in `web/src/session/checklists.ts` — the IDs MUST match so existing
 * `sessions.checklist_state` rows continue to identify the same items.
 *
 * The in-game plugin GUI (`TowerChecklistGui.cs`) cannot import the web file, so
 * it relies on the backend serving these defaults via
 * `GET /v1/session/:sessionId/checklist` whenever the session has no override.
 *
 * Layout follows a real-world "Normal Operating Checklists" card: seven phases
 * from before-engine-start through parking. Pilot side mirrors the printed card;
 * controller side is the matching tower-cab actions for the same phase.
 */
export const DEFAULT_CHECKLIST_PHASES: ChecklistPhaseDef[] = [
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
