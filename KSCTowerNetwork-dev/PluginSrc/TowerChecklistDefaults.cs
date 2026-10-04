using System;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Hardcoded fallback checklists used by <see cref="TowerChecklistGui"/> before the
    /// first successful <c>GET /v1/session/{id}/checklist</c> response, and any time the
    /// plugin can't reach the backend (no session id yet, not logged in, server down).
    ///
    /// Three vehicle modes (rocket / plane / rover) get distinct phase + item ids so
    /// switching mode mid-session doesn't cause stale done-state from a previous craft to
    /// bleed across — picked via <see cref="BuildForMode"/> driven by <see cref="TowerCraftMode"/>.
    ///
    /// The plane variant MUST stay in lockstep with:
    ///   - <c>backend/src/services/defaultChecklist.ts</c> (DEFAULT_CHECKLIST_PHASES)
    ///   - <c>web/src/session/checklists.ts</c> (CHECKLIST_PHASES)
    /// because those phase + item ids are what existing <c>sessions.checklist_state</c> rows
    /// were written under. Rocket / rover variants are plugin-only for now (no backend
    /// equivalent) so unique <c>rkt_</c> / <c>rvr_</c> prefixes keep them out of the way.
    ///
    /// Layout follows real-world "Normal Operating Checklists" cards. Em dashes / ellipses
    /// are emitted as \u2014 / \u2026 escapes to keep this source file ASCII-clean for
    /// picky build tools.
    /// </summary>
    public static class TowerChecklistDefaults
    {
        /// <summary>
        /// Back-compat entry point — returns the plane checklist (the original default).
        /// New callers should prefer <see cref="BuildForMode"/> so the cards reflect the
        /// craft the player is actually flying.
        /// </summary>
        public static TowerChecklistGui.PhaseDto[] Build()
        {
            return BuildPlane();
        }

        /// <summary>
        /// Pick the right card stack for the current craft. Falls back to plane on any
        /// unexpected enum value so a future <see cref="CraftMode"/> addition can't blank
        /// the checklist panel.
        /// </summary>
        public static TowerChecklistGui.PhaseDto[] BuildForMode(CraftMode mode)
        {
            switch (mode)
            {
                case CraftMode.Rocket: return BuildRocket();
                case CraftMode.Rover: return BuildRover();
                case CraftMode.Plane:
                default:
                    return BuildPlane();
            }
        }

        // -------- Plane (existing seven-phase ATC card) --------

        public static TowerChecklistGui.PhaseDto[] BuildPlane()
        {
            return new[]
            {
                Phase("before-start", "Before Engine Start",
                    Items(
                        Item("bs_parking_brake", "Parking brake \u2014 SET"),
                        Item("bs_battery", "Battery charge \u2014 CHECK"),
                        Item("bs_fuel", "Fuel quantity \u2014 CHECK"),
                        Item("bs_staging", "Staging \u2014 CHECK"),
                        Item("bs_flight_plan", "Flight plan \u2014 FILED"),
                        Item("bs_lights", "Lights \u2014 ON"),
                        Item("bs_flaps", "Flaps \u2014 RETRACTED"),
                        Item("bs_gear", "Landing gear \u2014 DOWN / GREEN"),
                        Item("bs_throttle", "Throttle \u2014 IDLE")),
                    Items(
                        Item("ct_bs_atis", "Issue ATIS / weather"),
                        Item("ct_bs_clearance", "Acknowledge flight plan / clearance"))),
                Phase("before-takeoff", "Before Takeoff",
                    Items(
                        Item("bt_atc", "ATC \u2014 ADVISE"),
                        Item("bt_cabin", "Cabin \u2014 READY"),
                        Item("bt_flt_controls", "Flight controls \u2014 TEST"),
                        Item("bt_trim", "Trim \u2014 AS REQUIRED"),
                        Item("bt_flaps", "Flaps \u2014 AS REQUIRED"),
                        Item("bt_spoiler", "Spoiler \u2014 RETRACTED"),
                        Item("bt_auto_speed_brake", "Auto speed brake \u2014 OFF"),
                        Item("bt_brakes_force", "Brake force \u2014 SET"),
                        Item("bt_parking_brake", "Parking brake \u2014 SET"),
                        Item("bt_lights", "Lights \u2014 ON"),
                        Item("bt_nav_radio", "NAV radio \u2014 SET"),
                        Item("bt_thrust_limit", "Thrust limit \u2014 AS REQUIRED"),
                        Item("bt_engine_mode", "Engine mode \u2014 AS REQUIRED"),
                        Item("bt_engine_gimbal", "Engine gimbal \u2014 AS REQUIRED"),
                        Item("bt_sas", "SAS \u2014 ON, STAB"),
                        Item("bt_avionics", "Avionics \u2014 CHECK"),
                        Item("bt_apu", "APU \u2014 ON"),
                        Item("bt_briefing", "Briefing \u2014 CONFIRMED")),
                    Items(
                        Item("ct_bt_taxi", "Clear to taxi via \u2026 to runway \u2026"),
                        Item("ct_bt_lineup", "Line up and wait"),
                        Item("ct_bt_clear_to", "Cleared for takeoff"))),
                Phase("after-takeoff", "After Takeoff",
                    Items(
                        Item("at_apu", "APU \u2014 OFF"),
                        Item("at_lights", "Lights \u2014 OFF"),
                        Item("at_gear", "Landing gear \u2014 UP"),
                        Item("at_flaps", "Flaps \u2014 RETRACTED")),
                    Items(
                        Item("ct_at_handoff_dep", "Hand off to departure"),
                        Item("ct_at_traffic", "Issue traffic advisories"))),
                Phase("descent", "Descent",
                    Items(
                        Item("ds_auto_speed_brake", "Auto speed brake \u2014 ARM"),
                        Item("ds_apu", "APU \u2014 ON"),
                        Item("ds_lights", "Lights \u2014 ON"),
                        Item("ds_nav_radio", "NAV radio \u2014 SET"),
                        Item("ds_briefing", "Briefing \u2014 CONFIRMED")),
                    Items(
                        Item("ct_ds_descend", "Descend when ready"),
                        Item("ct_ds_handoff_app", "Hand off to approach"))),
                Phase("approach-landing", "Approach / Landing",
                    Items(
                        Item("al_cabin", "Cabin \u2014 READY"),
                        Item("al_trim", "Trim \u2014 AS REQUIRED"),
                        Item("al_flaps", "Flaps \u2014 AS REQUIRED"),
                        Item("al_gear", "Landing gear \u2014 DOWN / GREEN"),
                        Item("al_radar_alt", "Radar altitude \u2014 MDA / DH SET"),
                        Item("al_nav_radio", "NAV radio \u2014 SET"),
                        Item("al_thrust_limit", "Thrust limit \u2014 AS REQUIRED"),
                        Item("al_engine_mode", "Engine mode \u2014 AS REQUIRED"),
                        Item("al_engine_gimbal", "Engine gimbal \u2014 AS REQUIRED")),
                    Items(
                        Item("ct_al_clear_approach", "Cleared approach runway \u2026"),
                        Item("ct_al_handoff_twr", "Hand off to tower"),
                        Item("ct_al_clear_land", "Cleared to land"))),
                Phase("after-landing", "After Landing",
                    Items(
                        Item("la_sas", "SAS \u2014 OFF"),
                        Item("la_parking_brake", "Parking brake \u2014 OFF"),
                        Item("la_spoiler", "Spoiler \u2014 RETRACTED"),
                        Item("la_auto_speed_brake", "Auto speed brake \u2014 OFF")),
                    Items(
                        Item("ct_la_taxi_park", "Taxi to parking"),
                        Item("ct_la_handoff_gnd", "Hand off to ground"))),
                Phase("parking", "Parking",
                    Items(
                        Item("pk_recovery", "Vessel recovery call \u2014 AS REQUIRED"),
                        Item("pk_staging", "Staging \u2014 CHECK"),
                        Item("pk_engine", "Engine \u2014 SHUTDOWN"),
                        Item("pk_throttle", "Throttle \u2014 IDLE"),
                        Item("pk_trim", "Trim \u2014 RESET / CHECK"),
                        Item("pk_lights", "Lights \u2014 OFF"),
                        Item("pk_parking_brake", "Parking brake \u2014 SET")),
                    Items(
                        Item("ct_pk_recovery", "Acknowledge vessel recovery"),
                        Item("ct_pk_close", "Close strip / log session")))
            };
        }

        // -------- Rocket (launch through recovery) --------

        public static TowerChecklistGui.PhaseDto[] BuildRocket()
        {
            return new[]
            {
                Phase("rkt-prelaunch", "Pre-Launch",
                    Items(
                        Item("rkt_pl_clamps", "Launch clamps \u2014 ARMED"),
                        Item("rkt_pl_battery", "Battery / EC \u2014 CHECK"),
                        Item("rkt_pl_fuel", "Propellant \u2014 FULL"),
                        Item("rkt_pl_staging", "Staging \u2014 VERIFIED"),
                        Item("rkt_pl_sas", "SAS \u2014 ON, STAB"),
                        Item("rkt_pl_rcs", "RCS \u2014 AS REQUIRED"),
                        Item("rkt_pl_gimbal", "Engine gimbal \u2014 ENABLED"),
                        Item("rkt_pl_abort", "Abort action group \u2014 ARMED"),
                        Item("rkt_pl_antennas", "Antennas / solar \u2014 STOWED"),
                        Item("rkt_pl_throttle", "Throttle \u2014 SET FOR LIFTOFF")),
                    Items(
                        Item("ct_rkt_pl_pad_clear", "Pad area \u2014 CLEAR"),
                        Item("ct_rkt_pl_window", "Launch window \u2014 CONFIRMED"),
                        Item("ct_rkt_pl_clear_launch", "Cleared for launch"))),
                Phase("rkt-ascent", "Ascent",
                    Items(
                        Item("rkt_as_ignition", "Ignition / liftoff \u2014 CONFIRMED"),
                        Item("rkt_as_pitch_program", "Pitch program \u2014 STARTED"),
                        Item("rkt_as_max_q", "Max-Q \u2014 PASSED"),
                        Item("rkt_as_meco", "MECO \u2014 CONFIRMED"),
                        Item("rkt_as_stage_sep", "Stage separation \u2014 CLEAN"),
                        Item("rkt_as_fairings", "Fairings \u2014 JETTISONED"),
                        Item("rkt_as_seco", "SECO \u2014 CONFIRMED")),
                    Items(
                        Item("ct_rkt_as_handoff_range", "Hand off to range / mission"),
                        Item("ct_rkt_as_track", "Tracking \u2014 NOMINAL"))),
                Phase("rkt-orbit", "Orbit Insertion",
                    Items(
                        Item("rkt_or_circ_burn", "Circularization burn \u2014 EXECUTED"),
                        Item("rkt_or_attitude", "Attitude \u2014 PROGRADE / AS REQ"),
                        Item("rkt_or_solar", "Solar panels \u2014 DEPLOYED"),
                        Item("rkt_or_antennas", "Antennas \u2014 DEPLOYED"),
                        Item("rkt_or_radiators", "Radiators \u2014 DEPLOYED"),
                        Item("rkt_or_science", "Science instruments \u2014 ARMED")),
                    Items(
                        Item("ct_rkt_or_orbit_confirm", "Orbit parameters \u2014 CONFIRMED"),
                        Item("ct_rkt_or_handoff_mission", "Hand off to mission control"))),
                Phase("rkt-deorbit", "De-Orbit / Re-Entry",
                    Items(
                        Item("rkt_de_attitude", "Attitude \u2014 RETROGRADE"),
                        Item("rkt_de_burn", "De-orbit burn \u2014 EXECUTED"),
                        Item("rkt_de_panels", "Solar / antennas \u2014 RETRACTED"),
                        Item("rkt_de_heatshield", "Heatshield \u2014 ARMED"),
                        Item("rkt_de_chutes_armed", "Parachutes \u2014 ARMED"),
                        Item("rkt_de_landing_gear", "Landing gear \u2014 ARMED")),
                    Items(
                        Item("ct_rkt_de_reentry_window", "Re-entry corridor \u2014 CONFIRMED"),
                        Item("ct_rkt_de_recovery_alert", "Recovery team \u2014 NOTIFIED"))),
                Phase("rkt-recovery", "Touchdown / Recovery",
                    Items(
                        Item("rkt_rc_chutes_open", "Parachutes \u2014 OPEN"),
                        Item("rkt_rc_touchdown", "Touchdown \u2014 CONFIRMED"),
                        Item("rkt_rc_engine_safe", "Engines \u2014 SAFED"),
                        Item("rkt_rc_rcs_off", "RCS \u2014 OFF"),
                        Item("rkt_rc_sas_off", "SAS \u2014 OFF"),
                        Item("rkt_rc_recovery_call", "Vessel recovery \u2014 CALLED")),
                    Items(
                        Item("ct_rkt_rc_recovery_ack", "Recovery acknowledged"),
                        Item("ct_rkt_rc_close", "Close strip / log mission")))
            };
        }

        // -------- Rover (ground operations) --------

        public static TowerChecklistGui.PhaseDto[] BuildRover()
        {
            return new[]
            {
                Phase("rvr-preroll", "Pre-Roll",
                    Items(
                        Item("rvr_pr_brake", "Parking brake \u2014 SET"),
                        Item("rvr_pr_battery", "Battery / EC \u2014 CHECK"),
                        Item("rvr_pr_solar", "Solar / RTG \u2014 DEPLOYED"),
                        Item("rvr_pr_lights", "Lights \u2014 ON"),
                        Item("rvr_pr_antenna", "Antenna \u2014 DEPLOYED"),
                        Item("rvr_pr_science", "Science instruments \u2014 STOWED"),
                        Item("rvr_pr_wheels", "Wheels / steering \u2014 CHECK"),
                        Item("rvr_pr_throttle", "Throttle limit \u2014 SET")),
                    Items(
                        Item("ct_rvr_pr_route", "Route briefing \u2014 ISSUED"),
                        Item("ct_rvr_pr_clear_roll", "Cleared to roll"))),
                Phase("rvr-driving", "Driving",
                    Items(
                        Item("rvr_dr_brake_off", "Parking brake \u2014 OFF"),
                        Item("rvr_dr_sas", "SAS \u2014 AS REQUIRED"),
                        Item("rvr_dr_speed", "Max speed \u2014 OBSERVED"),
                        Item("rvr_dr_heading", "Heading \u2014 ON COURSE"),
                        Item("rvr_dr_terrain", "Terrain hazards \u2014 SCANNING"),
                        Item("rvr_dr_battery_load", "Battery load \u2014 NOMINAL")),
                    Items(
                        Item("ct_rvr_dr_traffic", "Traffic advisories \u2014 ISSUED"),
                        Item("ct_rvr_dr_waypoint", "Waypoint check \u2014 ACK"))),
                Phase("rvr-onsite", "On-Site Work",
                    Items(
                        Item("rvr_os_arrived", "Site arrival \u2014 CONFIRMED"),
                        Item("rvr_os_brake", "Parking brake \u2014 SET"),
                        Item("rvr_os_solar_align", "Solar panels \u2014 ALIGNED"),
                        Item("rvr_os_science_deploy", "Science \u2014 DEPLOYED / RUN"),
                        Item("rvr_os_data_xmit", "Data transmit \u2014 COMPLETE")),
                    Items(
                        Item("ct_rvr_os_log", "Site report \u2014 LOGGED"),
                        Item("ct_rvr_os_next", "Next leg \u2014 BRIEFED"))),
                Phase("rvr-park", "Park / Shutdown",
                    Items(
                        Item("rvr_pk_brake", "Parking brake \u2014 SET"),
                        Item("rvr_pk_throttle", "Throttle \u2014 IDLE"),
                        Item("rvr_pk_lights", "Lights \u2014 OFF"),
                        Item("rvr_pk_science_stow", "Science instruments \u2014 STOWED"),
                        Item("rvr_pk_solar_stow", "Solar panels \u2014 STOWED"),
                        Item("rvr_pk_battery_state", "Battery state \u2014 LOGGED")),
                    Items(
                        Item("ct_rvr_pk_recovery", "Recovery / handover \u2014 ACK"),
                        Item("ct_rvr_pk_close", "Close strip / log session")))
            };
        }

        // -------- Builders --------

        private static TowerChecklistGui.PhaseDto Phase(
            string id, string title,
            TowerChecklistGui.ItemDto[] pilot,
            TowerChecklistGui.ItemDto[] controller)
        {
            return new TowerChecklistGui.PhaseDto
            {
                id = id,
                title = title,
                pilot = pilot,
                controller = controller
            };
        }

        private static TowerChecklistGui.ItemDto Item(string id, string label)
        {
            return new TowerChecklistGui.ItemDto { id = id, label = label };
        }

        private static TowerChecklistGui.ItemDto[] Items(params TowerChecklistGui.ItemDto[] items)
        {
            return items ?? new TowerChecklistGui.ItemDto[0];
        }
    }
}
