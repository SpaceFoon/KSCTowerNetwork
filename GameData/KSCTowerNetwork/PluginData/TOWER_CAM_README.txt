KSC Tower Network — tower lookout craft (HullCam → web)
=======================================================

The web "tower view" is JPEG frames from your KSP **flight** scene, not the
Space Centre UI camera. You need:

  - Hullcam VDS Continued (HullCam parts)
  - JustReadTheInstructions (JRTI) — exposes cameras on http://127.0.0.1:8080/
  - KSCTowerNetwork plugin: enable **CAM** (HullCam relay) on the radio HUD,
    log in with a **tower-eligible** account, turn **Stream as Tower** (TWR) on
    so uploads go to session id `KSC-TOWER-*`.

Build a minimal craft in the VAB / SPH
---------------------------------------
  1. Root: any probe core with internal power (e.g. OCTO, HECS).
  2. Attach a Hullcam VDS camera part (e.g. **hc_wideangle**, **hc_launchcam**,
     **aerocam** — surface-attach is fine).
  3. Rotate the camera so that, when the vessel sits at your chosen KSC spot,
     the HullCam looks over the runway / traffic area you care about.
  4. Save as e.g. `KSC-Tower-Cam` under your save's Ships folder.

Load in flight
--------------
  - Launch or place the craft **landed** near the KSC tower / runway so the
    HullCam sees the same airspace as ghost traffic (see docs:
    GHOSTS_AND_TOWER_VIEW_PLAN.md).
  - Confirm JRTI lists the camera (browser: http://127.0.0.1:8080/cameras ).
  - In-game: CAM on, TWR on if you are the dedicated tower publisher.

Space Centre "Park at KSC tower" is **disabled** in this plugin (camera bugs).
On the repo clone, see: KSCTowerNetwork-dev/docs/DISABLED_FEATURES.md

Bundled .craft
--------------
There is no mandatory bundled `.craft` — part choices and mod lists differ per
install. Build in the editor so missing Hullcam does not produce a unloadable ship.
