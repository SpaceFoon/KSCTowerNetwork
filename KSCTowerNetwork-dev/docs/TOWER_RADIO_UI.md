# Tower radio panel (in-game IMGUI)

This document describes the **floating cockpit radio** implemented in
[`PluginSrc/TowerRadioGui.cs`](../PluginSrc/TowerRadioGui.cs) and the small
supporting pieces it relies on for **MHz display**, **COM channel spacing**,
**helmet listen volume**, and **preset arrows**.

For voice TCP, bridge spawn, and ON AIR semantics, see
[`PLUGIN.md`](PLUGIN.md) and [`VOICE_BRIDGE.md`](VOICE_BRIDGE.md). For IVA
hardware sync, see [`INTEGRATIONS.md`](INTEGRATIONS.md).

---

## Scope

The panel includes: title bar shortcuts (ACARS / checklist / notes /
close), LED row, ghost-fleet row, **digital tune dial** (LCD + ◀ / ▶ quick
presets + six frequency knobs + COPY / PASTE / SET), ATIS readout, RX/TX VU meters,
**listen power** row, **VOL** control, PTT bar, status line, launch-assist row,
and utility footer (reconnect bridge, optional park-at-tower, log out).

Quick preset MHz values are aligned with
[`backend/src/config/radioPresets.ts`](../backend/src/config/radioPresets.ts)
(and the backend’s operational rooms).

---

## MHz LCD (procedural 7-segment)

**Why not a font:** KSP’s Unity version makes loading arbitrary `.ttf` paths at
runtime unreliable for this strip. The MHz readout uses **classic 7-segment
glyphs** (seven rectangular segment bars **a–g** per cell, plus a dedicated
decimal dot cell), drawn with a 1×1 white texture tinted via `GUI.color` on
`EventType.Repaint` only. The release build does **not** ship extra LCD fonts for
this strip.

**Layout:** Seven fixed columns match the six tuning knobs + narrow decimal
column (`TuneDialColumnX` / `TuneDialColumnWidth`, `TuneDialDecimalColWeight`).

The MHz strip always shows canonical **`NNN.NNN`** on the LCD (all six numeric
glyph positions + decimal dot); subtitles and status lines use
`FormatCanonicalMhzHumanNoTrailingZeros` for shorter text (e.g. `128.25 MHz`).

Key helpers (all in `TowerRadioGui.cs` unless noted):

| Symbol | Role |
|--------|------|
| `EnsureSegmentFillTex` | Shared 1×1 fill texture for segments and decimal dot. |
| `SegmentMaskForChar` | Bitmask for `0`–`9`, `-`, em-dash (placeholder). |
| `DrawSevenSegmentDigit` / `DrawSevenSegmentDot` | Geometry inside each cell. |
| `DrawFrequencyLcdMainDigits` | Column loop + Repaint guard. |

---

## COM frequency: 25 kHz grid and display

**Channel spacing:** VHF COM channels are snapped to **25 kHz** (0.025 MHz)
using **integer kilohertz** rounding: `round(kHz / 25) × 25`, then converted back
to MHz. This avoids floating-point noise producing non-tunable thousandths
(e.g. `127.549999` → a valid channel, not garbage digits).

**Internal canonical form:** APIs, `SessionId` when it is a literal frequency,
and the six frequency knobs still use strict **`NNN.NNN`** (regex
`^[0-9]{3}\.[0-9]{3}$`) so existing parsers and the backend stay unchanged.

**Snapping entry points:**

| Path | Behavior |
|------|----------|
| `FormatMhzDoubleToCanonical` | Snaps then formats `NNN.NNN` (used from IVA dial via `RequestTuneFromIvaCommRadio`). |
| `SnapCanonicalFreqString` | Parses canonical string → snap → canonical again. |
| `ExtractFrequencyFromText` / paste | Builds candidate `NNN.NNN`, then snaps. |
| `CommitDialFrequency` | Snaps staged digits before `TuneToTypedFrequency`; if the dial was off-grid, digits update and the status line notes the snap. |
| `TuneToTypedFrequency` | After the ATIS early-out, if `targetFreq` matches the frequency regex, it is **replaced** with the snapped canonical string so claim-pilot, lobby hints, and “already on” checks see the same MHz the server expects. |
| `FrequenciesMatchOn25KhzGrid` | Ordinal equality, or both `NNN.NNN` with equal snapped values (`IsCurrentRoomOnFrequency`, `TryFindRoomIdForFrequency`). |
| `FormatCanonicalMhzForAviationLcdSeven` | Snapped canonical → 7-char LCD (`NNN.NNN`, always six numeric glyphs + dot). |
| `FormatCanonicalMhzHumanNoTrailingZeros` | Parsed MHz → shortest decimal string for status/subtitle/`AdoptRoomId`. |
| `FreqOrLobbyStringToAviationLcdSeven` | Lobby/API MHz string → LCD (canonical, extract-from-text, or session placeholder). |

**Equality on the grid:** `FrequenciesMatchOn25KhzGrid` (table above) also covers
lobby `frequencyMhz` strings that differ only by off-grid typing vs. the tuned
canonical value.

**LCD vs. STAGED:** While `_dialDirty` (knobs edited, SET not pressed), the big
readout shows full **`NNN.NNN`** from the knobs **without** 25 kHz snap so the
strip matches the staged positions; **SET** applies snap and tuning. The
subtitle shows **STAGED** and **SET** until commit.

**LCD string:** `FormatCanonicalMhzForAviationLcdSeven` always returns seven
characters `NNN.NNN` (with 25 kHz snap when `snapToGrid` is true).

**Human strings:** `FormatCanonicalMhzHumanNoTrailingZeros` formats the snapped
canonical MHz for status lines, subtitles (`… MHz`), and `AdoptRoomId`
messages without unnecessary trailing fractional zeros.

**Lobby vs. committed MHz:** `TryGetCommittedCanonicalMhz` and the tune dial’s
`canonMhz` preset-index logic use the same rules: canonical regex → snap;
otherwise `ExtractFrequencyFromText` fallback when the server sends a loose
string.

---

## Helmet listen volume (VOL)

A compact **VOL** button sits to the right of the listen **power** row
(`DrawPowerRow`). Each click cycles output: **100% → mute → 25% → 50% → 75% →
100%** (from the current level it snaps to the nearest step, then advances).

- **Runtime:** `TowerVoicePlayback` applies the level on its stream
  `AudioSource` (`RefreshListenVolumeFromSettings`, applied in `Awake` and
  whenever the setting changes).
- **Persistence:** `TowerModSettings.VoiceListenVolume` (0…1), saved to
  `GameData/KSCTowerNetwork/PluginData/auth.cfg` as `voiceListenVolume`. An
  optional **`voiceListenVolume`** in `settings.cfg` seeds the value when that
  file is read; **`auth.cfg` is always merged afterward** (even if
  `settings.cfg` is missing), so the in-game **VOL** control and other auth
  keys override seeds when present. See
  [`SETTINGS_REFERENCE.md`](SETTINGS_REFERENCE.md).

---

## Preset arrows (◀ / ▶)

Unicode triangles in a round hit target were visually off-center. The UI uses
small **procedural triangle textures** (`MakePresetArrowTex`), drawn on Repaint
inside `DrawPresetArrowInCircle`, with `GUI.Button` only for the hit area
(`_arrowHitStyle` + `_texClear`).

---

## Related source files

| File | Relevance |
|------|-----------|
| `TowerRadioGui.cs` | Entire panel, frequency logic, 7-segment draw, VOL, arrows. |
| `TowerModSettings.cs` | `VoiceListenVolume`, `SetVoiceListenVolume`, `auth.cfg` save. |
| `TowerVoicePlayback.cs` | PCM stream; `RefreshListenVolumeFromSettings`. |
| `TowerCommRadioFreqSync.cs` | IVA dial → `RequestTuneFromIvaCommRadio` (double MHz). |
| `TowerVoiceListenUiLogic.cs` | Pure rules for ON AIR / bridge lamps (unit-tested). |

---

## Operational notes

- **`auth.cfg` without `settings.cfg`:** `TowerModSettings.EnsureLoaded` still
  calls `LoadAuthOverlayIfPresent()` when `settings.cfg` is missing or fails to
  parse, so `voiceListenVolume` and the encrypted JWT load correctly.
- **ATIS** preset MHz must stay consistent with `AtisPresetMhz` in code and
  `radioPresets.ts` / backend ATIS routes.
- **Build:** Recompile with `KSCTowerNetwork-dev/build-plugin.ps1`. If the DLL
  copy fails with `CS0016`, exit KSP so `KSCTowerNetwork.Client.dll` is not
  memory-mapped.
