# Publishing KSCTowerNetwork to CKAN

This folder holds the metadata CKAN needs to install the mod. There are three
files plus the in-game version file shipped with the mod itself:

| File | Lives where | Purpose |
|---|---|---|
| `KSCTowerNetwork.netkan` | this folder; **submitted to** [`KSP-CKAN/NetKAN`](https://github.com/KSP-CKAN/NetKAN) | Tells the NetKAN-Inflator bot to auto-track every GitHub Release tag and add it to the CKAN catalog. Submit once; bot does the rest forever. |
| `KSCTowerNetwork.ckan` | this folder; template for a separate generated release asset | Static fallback metadata. Users can drag the `.ckan` onto the CKAN client to install without the catalog. |
| `KSCTowerNetwork.version` | `GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version` (already in place) | KSP-AVC + NetKAN read this for the version number. Source of truth for the version. |
| `LICENSE` | repo root (MIT) | Required for CKAN to legally redistribute the ZIP. |

### Maintaining `KSCTowerNetwork.version` (truth + AVC)

Players who install **KSP Add-on Version Checker (AVC)** read this JSON beside the DLL. CKAN’s NetKAN bot also reads it via `$vref` in `KSCTowerNetwork.netkan`. No C# changes are required; the file is the contract.

1. **`VERSION`** — Must match what you are actually shipping. **GitHub Release tags must match this** (e.g. tag `v1.2.3` ↔ `MAJOR` 1, `MINOR` 2, `PATCH` 3) or NetKAN skips the release.
2. **`KSP_VERSION_MIN` / `KSP_VERSION_MAX`** — Set to the KSP builds you **test** against. AVC shows these as compatibility; lying here misleads players and wastes support time. Keep them aligned with the `ksp_version_min` / `ksp_version_max` fields in `KSCTowerNetwork.netkan` unless you have a deliberate reason not to.
3. **`URL`** — After placeholders are replaced, this must be the **raw** GitHub URL of the same `.version` JSON on your default branch (pattern: `https://raw.githubusercontent.com/<user>/KSCTowerNetwork/<branch>/GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version`, or a copy at `ckan/KSCTowerNetwork.version` if you choose to host the canonical file there — then match that path exactly). AVC fetches this to offer in-game update checks; a wrong URL or a non-raw `github.com/blob/...` link breaks updates silently from the player’s perspective.
4. **`DOWNLOAD` / `GITHUB`** — Replace `REPLACE_ME_OWNER` so they point at your real repo and releases page.

**Release discipline:** bump `VERSION` here in the same commit you bump `AssemblyInfo.cs` and `ckan/KSCTowerNetwork.ckan`, then tag. See **Cutting a release** below.

---

## One-time setup

1. **Create the GitHub repo.** Suggested name: `KSCTowerNetwork`. Push everything except secrets (`release-config.json`, `.env*`, `node_modules`).
2. **Replace every `REPLACE_ME_*` placeholder** in:
   - `ckan/KSCTowerNetwork.netkan`
   - `ckan/KSCTowerNetwork.ckan`
   - `GameData/KSCTowerNetwork/Plugins/KSCTowerNetwork.version`

   Specifically:
   - `REPLACE_ME_OWNER` → your GitHub username/org (e.g. `darrenfoo`).
   - `REPLACE_ME_AUTHOR` → display name for the CKAN listing.
   - `REPLACE_ME_SHA1_OF_RELEASE_ZIP` / `REPLACE_ME_SHA256_OF_RELEASE_ZIP` → only for the static `.ckan`, after you build the release ZIP. `certutil -hashfile KSCTowerNetwork-1.0.0.zip SHA256` on Windows.

3. **Verify the dependency identifiers** in the CKAN catalog. The names below are the ones I used; spot-check them against the live catalog at <https://github.com/KSP-CKAN/CKAN-meta> by searching for each:
   - `ModuleManager` (definitely correct, hard `depends`)
   - `recommends`: `ClickThroughBlocker`, `RasterPropMonitor`, `ASET-Props`, `ASET-Avionics`, `AvionicsSystems`, `kOS`, `HullcamVDSContinued`, `JustReadTheInstructions`
   - `suggests`: `KSAIVAUpgrade`, `Reviva`, `FreeIva`, `kOSPropMonitor`, `VesselView`, `DE-IVAExtension`, `Kerbalism`, `Chatterer`

   Identifiers I'm less than 100% sure about (verify against `CKAN-meta` before submitting; the NetKAN bot will reject typos):
   - `KSAIVAUpgrade` — folder is `KSA/IVAUpgrade`, version file `KSA_IVAUpgrade.version`. CKAN id might be `KSAIVAUpgrade`, `KSA-IVAUpgrade`, or `KSAIVAU`.
   - `kOSPropMonitor` — folder `kPM`, version file `kOSPropMonitor.version`.
   - `VesselView` — confirmed: CKAN-meta indexes it as `identifier: VesselView`, display name "Vessel Viewer Continued" (linuxgurugamer). Current `suggests` entry is correct as-is.
   - `JustReadTheInstructions` — niche mod, may not be in CKAN-meta at all (drop to documentation-only if rejected).
   - `Kerbalism` — ships in multiple flavors (`Kerbalism`, `KerbalismCore`, `Kerbalism-RO`). Confirm which is the umbrella id.

   The split between `recommends` and `suggests` is intentional: anything in `recommends` drives a feature the mod actively advertises (PTT prop, COMM-radio sync on both RPM and MAS cockpits, kOS bridge / screen mirror, HullCam relay) or fixes a real safety bug (ClickThroughBlocker prevents flight-scene clicks bleeding through our IMGUI windows onto parts / staging). HullcamVDS Continued is recommended alongside JRTI because JRTI itself is useless without it — the camera PartModule comes from HullcamVDS and JRTI just exposes it over HTTP.

   ClickThroughBlocker is wired up via runtime reflection (`PluginSrc/TowerClickBlock.cs`) — same soft-bind pattern as the Kerbalism radiation hook. The mod loads and runs without ClickThroughBlocker installed, just with the leaky vanilla `GUI(.Layout).Window` behavior. That's why it sits in `recommends` rather than `depends`: stripped-down installs still work, but anyone who actually flies should have it.

   Items in `suggests` are nice-to-haves the player either won't always want, or that only matter for narrow cases:
   - `KSAIVAUpgrade` — adds full RPM/ASET IVAs (with the COMM radio prop) to the **stock** Squad pods. Borderline `recommends`: without something like this, the COMM-radio sync only fires in the few pods that ship with ASET IVAs out of the box. Left in `suggests` because not every player flies stock.
   - `Reviva` — IVA chooser/swapper. Our `MM_HookCommRadio.cfg` is `:FINAL` specifically so the COMM-radio sync hooks survive a Reviva IVA swap. Pairs well, not required.
   - `FreeIva` — walk-around-inside-the-cockpit IVA mod. Doesn't add a prop, just makes the IVA stack feel like a place you live in.
   - `kOSPropMonitor` (kPM) — in-cockpit kOS terminal display prop. Pairs with our **kOS terminal mirror** (same buffer goes to both the cockpit prop and the web tower's kOS-screen panel).
   - `VesselView` — exploded 2D vessel schematic in a Toolbar window (and an optional RPM IVA prop). Not used by the plugin directly today; intended to pair with the future Vessel Schematic web tile (see `VESSELVIEW_INTEGRATION_PLAN.md`).
   - `DE-IVAExtension` — only relevant for players who fly the DE Mk1 cockpit (the PTT prop auto-places into its IVA).
   - `Kerbalism` — a passive telemetry read (radiation rad/s) that enriches the strip view but isn't a player-visible feature on its own.
   - `Chatterer` — deliberately NOT recommended. The whole mod replaces Chatterer's role with real human voice over LiveKit; we don't add Chatterer functionality, we suppress it. The integration is purely defensive: if Chatterer happens to be installed, `TowerChattererDuck` mutes it (and the ASET radio's built-in fake ATC samples) while PTT is open so the chatter doesn't bleed into the real transmission. Recommending it would be telling the user to install fake chatter just so we can silence it.

   If any identifier is wrong the NetKAN bot will reject the file with a clear error pointing at the offending line. `JustReadTheInstructions` in particular: confirm the canonical id at <https://github.com/RELMYMathieu/JustReadTheInstructions> matches what's in CKAN-meta before submitting; if it isn't published to CKAN at all, drop it from `recommends` and call it out in the README only.

---

## Cutting a release

Use [the two-package release workflow](../docs/RELEASING.md). The builder emits
KSCTowerNetwork.ckan beside the final Client ZIP and fills its exact download URL,
size and hashes. Do not embed this metadata inside the archive it hashes.
The checked-in .ckan is a template; its hash placeholders are filled only in the
generated release asset. The NetKAN template selects Client ZIPs explicitly.
Catalog inclusion still needs a NetKAN submission and dependency review; publishing
a GitHub release alone does not register the mod in CKAN.

---

## Submitting to NetKAN (one-time)

1. Fork <https://github.com/KSP-CKAN/NetKAN>.
2. Drop `KSCTowerNetwork.netkan` into `NetKAN/` in your fork.
3. Open a PR. Their CI will inflate it against your GitHub repo as a smoke test; fix any errors it reports.
4. Once merged, every future GitHub Release lands in CKAN automatically — you never touch the catalog again unless dependencies change.

If you also want SpaceDock as a mirror: upload the ZIP there manually after each release. CKAN does not need a separate `.netkan` for the SpaceDock copy unless you want CKAN to track SpaceDock instead of GitHub (change `$kref` to `#/ckan/spacedock/<id>`).

---

## Server-side requirements

CKAN installs only the client. Players need an operator's backend hostname and
LiveKit-enabled service; configure PluginData/settings.cfg after installation.
Public Client ZIPs are neutral. Operators install the separate Server ZIP and
configure their private production environment using SERVER_HOSTING.md.
