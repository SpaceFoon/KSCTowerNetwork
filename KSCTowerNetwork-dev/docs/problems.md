# Problems found in this repo

Snapshot of issues found while auditing the in-flight changes (modified
`PluginSrc/`, `backend/`, `web/`, `build-plugin.ps1`) plus a few pre-existing
foot guns that the new tooling exposed.

Severity legend: **[bug]** breaks runtime / build, **[regression]** silently
removes a feature, **[hygiene]** lint / dead code / repo bloat.

---

## Bugs / regressions in the staged changes

### 1. [regression] Multi-channel preset feature is dead in `TowerModSettings`
The cfg loader still reads `channels=` and calls `ParseChannelPresets(...)`:

```csharp
// KSCTowerNetwork-dev/PluginSrc/TowerModSettings.cs:608-616
v = node.GetValue("channels");
if (!string.IsNullOrEmpty(v))
{
    ChannelPresets = ParseChannelPresets(v, SessionId);
}
else
{
    ChannelPresets = new[] { SessionId };
}
```

…but as soon as anything calls `SetActiveChannel(...)`, the list gets
clobbered:

```csharp
// KSCTowerNetwork-dev/PluginSrc/TowerModSettings.cs:998-1001
// One logical channel at a time — do not accumulate every visited room id into a
// preset list (that produced endless UUID/slug "channels" when stepping arrows).
ChannelPresets = new[] { t };
```

`ChannelPresets` is also no longer consumed anywhere — the radio's
`StepChannel` / `IndexOfPreset` were deleted. So loaded `channels=` entries
from the user's cfg are discarded on first tune and never used by anything.
Either drop the cfg field + `ParseChannelPresets` helper entirely, or restore
a real reader.

### 2. [bug] ACARS 403 messaging only customised for `session:` channels
`TowerAcarsGui.cs` only adds extra context for 403s on the room-chat channel:

```csharp
// KSCTowerNetwork-dev/PluginSrc/TowerAcarsGui.cs:411-425
if (req.responseCode == 403)
{
    var body = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
    var serverMsg = ExtractError(body);
    if (!string.IsNullOrEmpty(serverMsg))
    {
        detail = serverMsg;
    }

    if (channelKey.StartsWith("session:", StringComparison.Ordinal))
    {
        detail += " — room chat needs you to be pilot/tower/spectator of this SessionId "
            + "(dev-shared often mismatches your login).";
    }
}
```

Lobby / DM 403s only get the raw `serverMsg`. Either add equivalent hints for
`lobby` / `dm:` or move the contextual hint into the server's error body.

Also: with `?since=` removed on every channel, `_lastSinceIso` and any field
that drove it are likely dead — sweep them.

### 3. [regression] Removing `?since=` shifts all polling to full snapshots
`TowerAcarsGui.cs` now always pulls the entire room/lobby/DM transcript every
poll. Fixes the "one-way" symptom called out in the comments, but on a
long-running tower session with hundreds of messages it linearly grows
bridge bandwidth and KSP frame hitch each tick. Consider keeping the snapshot
for first fetch only and re-introducing `?since=` later with a real fix on
the server side.

### 4. Optional Kerbin chart installation

Third-party chart PDFs, rendered pages, transcripts/reference-data bundle and extracted terrain SVG are excluded from the public source branch. The unpublished bundle commit was replaced. Owners can download the upstream PDF separately and run the local installer; see [AEROCHART_REFERENCE.md](AEROCHART_REFERENCE.md). Generated assets retain CC BY-NC-SA 3.0. Retained operational navigation tables preserve their existing source attribution; live installed-game data remains authoritative.

---

## Existing problems exposed when running the new tooling

### 7. [bug] `web` does not type-check at all (11 errors, pre-existing on `master`)
`web/package.json` has no `typecheck` script, so this has been quietly
failing. Reproduced with `tsc --noEmit` in `web/`:

```
src/components/KerbinTowerMap.tsx(1268,3):  TS2322  RgbSampler return type breaks under noUncheckedIndexedAccess
src/components/KerbinTowerMap.tsx(1310,25): TS2345  samplerCache.get() can be undefined
src/components/KerbinTowerMap.tsx(1311,3):  TS2322  same
src/components/KerbinTowerMap.tsx(1366,27): TS2532  palette[i] possibly undefined  (×4)
src/components/SystemSchematic.tsx(356,9):  TS6133  'clientToSvg' declared but never read
src/pages/AdminDesk.tsx(1612,70):           TS2339  Property 'roomName' does not exist on Row union
src/pages/AdminDesk.tsx(1617,57):           TS2339  same
src/pages/BoothDesk.tsx(455,15):            TS2345  "booth messages" not assignable to ApiErrorContext
src/pages/DmDesk.tsx(167,49):               TS2532  messages[length-1] possibly undefined
```

Two are real correctness bugs:
- **`AdminDesk.tsx`** branches on `row.kind === "cooldown"`, but the `Row`
  union only has `"ban" | "mute"`. Either the cooldown variant was removed
  and these UI rows are dead, or the union forgot to add the new `cooldown`
  variant. Either way the branch either never fires or renders `undefined`
  in the cell + button title.
- **`BoothDesk.tsx`** passes context string `"booth messages"` that isn't in
  `ApiErrorContext`, so `formatApiError` falls through to the unknown-context
  branch.

The rest are real-but-cosmetic strict-mode tightenings.

**Action:** add `"typecheck": "tsc --noEmit"` to `web/package.json` so this
doesn't keep rotting.

### 8. [hygiene] `npm test` in both packages runs against untracked test files
There are 30+ `*.test.ts` files in `backend/src/**` and `web/src/**` that
match the new test globs but are all untracked:

```
backend/src/config/radioPresets.test.ts
backend/src/lib/{httpRequestLogSilence,safeText,serverLogBuffer}.test.ts
backend/src/middleware/csrf.test.ts
backend/src/services/{checklistEvents,defaultChecklist,hullcamCompress,hullcamStore,
                     livekit,repository.booth,repository.helpers,repository.roles,
                     scoring,vesselManifestStore,worldInventory,worldMaps}.test.ts
web/src/api/client.test.ts
web/src/auth/session.test.ts
web/src/data/{kerbinAeroCharts,systemCatalog,worldInventoryClient,worldMapsClient}.test.ts
web/src/query/hooks.test.ts
web/src/scoring/rules.test.ts
web/src/session/{checklists,formatApiError}.test.ts
web/src/voice/livekit.test.ts
```

A fresh clone gets `npm test` → "no tests found", and they'll never get
reviewed. Commit them or remove the test scripts.

### 9. [bug] `vite.config.ts` imports config from `vitest/config`
```ts
import { defineConfig, type Plugin } from "vitest/config";
```
Works (vitest re-exports vite), but ties `vite build` to having vitest
resolvable. With `vitest` only in `devDependencies`, prod-clean installs
(`npm ci --omit=dev`) followed by `vite build` will fail with
"cannot find module 'vitest/config'". Safer pattern:

```ts
/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
```

…or `mergeConfig` from both.

---

## Smaller items

- **[hygiene] `TowerToolbar.cs`**: class doc comment at the top still says
  "the radio + charts launcher buttons appear on the very first screen";
  the charts launcher is gone now. Already partially updated — finish the
  sweep.
- **[hygiene] `worldMaps.ts` `meaningfulDomPurifyRemovals`**: `purify.removed`
  items can also be the `attribute` shape (string-keyed). Current filter
  `if ("attribute" in r) return true;` is correct; confirm with a unit
  test — one of the untracked tests is `worldMaps.test.ts`, perfect place.
- **[hygiene] `api.ts`**: `radioPresets: [...RADIO_QUICK_PRESETS]` spreads a
  `readonly` array into a mutable copy. JSON-serialised either way, but if
  callers should keep readonly typing, `radioPresets: RADIO_QUICK_PRESETS`
  is enough.

---

## Suggested order of fixes

1. **Issue 7** — add `web` `typecheck` script, fix the `AdminDesk` /
   `BoothDesk` real bugs, then bring the strict-mode tightenings to zero.
2. **Issue 1** — decide whether `ChannelPresets` / `ParseChannelPresets`
   stays or goes; today it's misleading dead code.
3. **Issue 9** — fix the vite/vitest import before someone hits it in CI.
4. **Issue 8** — commit the new test files (or remove the test scripts).
5. Mop up issues 2, 3, and the smaller items.
