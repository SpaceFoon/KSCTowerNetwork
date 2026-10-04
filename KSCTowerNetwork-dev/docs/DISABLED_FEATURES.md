# Disabled in-game features

Short list of shipped-off toggles so playtesters and future maintainers know what is intentionally absent from the UI or no-ops at runtime.

## Park at KSC tower (`TowerJumpToWindow`)

**Status:** disabled (compile-time).

The COMM radio footer used to expose **PARK AT KSC TWR**, which moved `Camera.main` and reflectively adjusted stock `SpaceCenterCamera2` pivot / distance fields so the view stayed on the tower. In practice this still corrupted Space Centre and related camera behaviour for many setups, so the action is turned off.

- **Code:** `PluginSrc/TowerJumpToWindow.cs` — field `TowerParkKscTwrEnabled` is `false`. Set it to `true` to re-enable `IsAvailable`, the footer button, and `JumpToTower()`; rebuild the plugin after changing it.
- **UI:** `PluginSrc/TowerRadioGui.cs` — `DrawUtilityFooter` only draws the park button when `TowerJumpToWindow.IsAvailable` is true.

Re-enable only after validating camera restore on your minimum supported KSP version(s).

**Tower video to the web app** does not use this feature. Use **Flight** + Hullcam VDS + JRTI + `TowerHullCamRelay` with a stationary tower marker craft and **Stream as Tower** (`KSC-TOWER-*`). See [GHOSTS_AND_TOWER_VIEW_PLAN.md](GHOSTS_AND_TOWER_VIEW_PLAN.md) Part B and in the install: `GameData/KSCTowerNetwork/PluginData/TOWER_CAM_README.txt`.
