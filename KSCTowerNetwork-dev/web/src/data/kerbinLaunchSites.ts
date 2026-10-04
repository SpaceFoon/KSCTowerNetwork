/**
 * Kerbin launch sites and airfields beyond the KSC complex itself (which already has its own marker).
 * Coordinates match KSP stock and the Making History expansion (PSystemSetup `LaunchSites`); a few are
 * documented community references where the cfg only specifies a PQS city, but they are accurate to within
 * a couple of game-meters at the equator. Edit / extend freely; the map picks up new entries automatically.
 */
export type KerbinLaunchSiteSource = "stock" | "making-history" | "kerbal-konstructs";

export type KerbinLaunchSite = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  source: KerbinLaunchSiteSource;
  /**
   * `true` for sites that have a usable runway (Island Airfield, Old Airfield)
   * vs vertical-only launch pads. Drives a distinct map glyph so pilots flying
   * with an un-upgraded KSC runway can spot a real alternate at a glance —
   * KSC's tier-1 dirt strip is short / unmarked / non-ILS; KAFD is the practical
   * overflow / divert field.
   */
  isAirfield?: boolean;
  /** Short description for the marker info modal. */
  blurb?: string;
};

export const KERBIN_LAUNCH_SITES: KerbinLaunchSite[] = [
  {
    id: "ISLAND",
    name: "Island Airfield (KAFD)",
    lat: -1.517,
    lon: -71.965,
    source: "stock",
    isAirfield: true,
    blurb: "1 200 m clay/grass island strip. Same area as the AIRFIELD VOR (IFT) and the BASE WEST/EAST NDBs. Useful as the overflow / divert field when KSC's runway hasn't been upgraded to the full 2 500 m concrete plate."
  },
  {
    id: "DESERT",
    name: "Old Airfield (Desert)",
    lat: -6.55983,
    lon: -143.95494,
    source: "stock",
    isAirfield: true,
    blurb: "Stock desert airfield on the far side of Kerbin. Available even without Making History — also a viable divert if KSC's runway is un-upgraded."
  },
  {
    id: "DESSERT_PAD",
    name: "Dessert Launch Site",
    lat: -6.55617,
    lon: -143.94734,
    source: "making-history",
    blurb: "Making History launch pad next to the Old Airfield. DLC required."
  },
  {
    id: "WOOMERANG",
    name: "Woomerang Launch Site",
    lat: 45.29076,
    lon: 136.11334,
    source: "making-history",
    blurb: "Northern-hemisphere launch complex on a remote plateau. DLC required."
  },
  {
    id: "BAIKERBANUR",
    name: "Baikerbanur Launch Site",
    lat: 20.65968,
    lon: -146.48504,
    source: "making-history",
    blurb: "Equatorial-ish launch complex west of the KSC continent. DLC required."
  }
];
