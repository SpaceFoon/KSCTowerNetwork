# Build KSCTowerNetwork.Client.dll into the deployed GameData mod folder.
#
# Layout this script assumes:
#   <KSP>\KSCTowerNetwork-dev\           <- this folder (dev workspace, OUTSIDE GameData)
#     PluginSrc\*.cs                     <- C# sources
#     build-plugin.ps1                   <- you are here
#   <KSP>\GameData\KSCTowerNetwork\      <- deployed mod (only what KSP must load)
#     Plugins\KSCTowerNetwork.Client.dll <- build output
#     Patches\*.cfg
#     Props\*
#     PluginData\*
#
# Anything else under GameData\KSCTowerNetwork\ (web\, backend\, node_modules\,
# *.md, package.json, ...) makes KSP scan hundreds of MB of npm garbage
# at boot and silently breaks the localizer (every UI string becomes
# "#autoLOC_xxxxx"). The Test-GameDataHygiene step below fails the build if any
# of those reappear under GameData\KSCTowerNetwork\.
#
# Close KSP before running: the running game holds an exclusive lock on
# KSCTowerNetwork.Client.dll.
#
# Pass -Dev to define DEV_AUTOFILL, which prefills the login window with the
# "pilot" dev preset (pilot@ksc.local / pilot12345) and display name "fooney".
# DO NOT ship a -Dev DLL: credentials are hard-coded in the assembly.

param(
    [switch]$Dev,
    # For source checkouts outside the game install; output still stays in this checkout.
    [string]$KspManagedPath
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$kspRoot = Resolve-Path (Join-Path $here "..")
$gameDataMod = Join-Path $kspRoot "GameData\KSCTowerNetwork"
$managed = Join-Path $kspRoot "KSP_x64_Data\Managed"
if ($KspManagedPath) { $managed = (Resolve-Path -LiteralPath $KspManagedPath).Path }
$fx = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fx "csc.exe"

$src = @(
    (Join-Path $here "PluginSrc\Properties\AssemblyInfo.cs"),
    (Join-Path $here "PluginSrc\TowerModSettings.cs"),
    (Join-Path $here "PluginSrc\TowerServerAddress.cs"),
    (Join-Path $here "PluginSrc\TowerSecureStore.cs"),
    (Join-Path $here "PluginSrc\TowerMainThreadDispatcher.cs"),
    (Join-Path $here "PluginSrc\TowerApiAuth.cs"),
    (Join-Path $here "PluginSrc\TowerLoginGui.cs"),
    (Join-Path $here "PluginSrc\TowerMicMeter.cs"),
    (Join-Path $here "PluginSrc\TowerSkin.cs"),
    (Join-Path $here "PluginSrc\TowerClickBlock.cs"),
    (Join-Path $here "PluginSrc\TowerImguiClickSink.cs"),
    (Join-Path $here "PluginSrc\TowerClearanceState.cs"),
    (Join-Path $here "PluginSrc\TowerRadioState.cs"),
    (Join-Path $here "PluginSrc\TowerSfx.cs"),
    (Join-Path $here "PluginSrc\TowerRadioGui.cs"),
    (Join-Path $here "PluginSrc\TowerDragonRadarGui.cs"),
    (Join-Path $here "PluginSrc\TowerTrafficRadarGui.cs"),
    (Join-Path $here "PluginSrc\TowerToolbar.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceAutoConnect.cs"),
    (Join-Path $here "PluginSrc\TowerSessionAutoCall.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceListenUiLogic.cs"),
    (Join-Path $here "PluginSrc\TowerVoicePlayback.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceBridgeControl.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceBridgeRespawnQueue.cs"),
    (Join-Path $here "PluginSrc\KSCTowerRpmMic.cs"),
    (Join-Path $here "PluginSrc\TowerPttBus.cs"),
    (Join-Path $here "PluginSrc\TowerCommRadioIvaPure.cs"),
    (Join-Path $here "PluginSrc\TowerCommRadioPersistents.cs"),
    (Join-Path $here "PluginSrc\KSCTowerCommRadioPtt.cs"),
    (Join-Path $here "PluginSrc\KSCTowerCommRadioPttBridge.cs"),
    (Join-Path $here "PluginSrc\TowerChattererDuck.cs"),
    (Join-Path $here "PluginSrc\TowerCommRadioFreqSync.cs"),
    (Join-Path $here "PluginSrc\TowerCommRadioRxSync.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceBridgeLauncher.cs"),
    (Join-Path $here "PluginSrc\TowerVoiceBridgeMenuQuit.cs"),
    (Join-Path $here "PluginSrc\TowerUdpClient.cs"),
    (Join-Path $here "PluginSrc\TowerTelemetryPublisher.cs"),
    (Join-Path $here "PluginSrc\TowerCountdownState.cs"),
    (Join-Path $here "PluginSrc\TowerTakeoffClearanceState.cs"),
    (Join-Path $here "PluginSrc\TowerCountdownHud.cs"),
    (Join-Path $here "PluginSrc\TowerWorldInventory.cs"),
    (Join-Path $here "PluginSrc\TowerBasemapBaker.cs"),
    (Join-Path $here "PluginSrc\TowerAcarsContracts.cs"),
    (Join-Path $here "PluginSrc\TowerAcarsGui.cs"),
    (Join-Path $here "PluginSrc\TowerAcarsActiveRoomSync.cs"),
    (Join-Path $here "PluginSrc\TowerAcarsKosBridge.cs"),
    (Join-Path $here "PluginSrc\TowerKosScreenAutoCapture.cs"),
    (Join-Path $here "PluginSrc\TowerHullCamRelay.cs"),
    (Join-Path $here "PluginSrc\TowerVesselManifestPublisher.cs"),
    (Join-Path $here "PluginSrc\TowerCraftThumbnailPaths.cs"),
    (Join-Path $here "PluginSrc\TowerCraftThumbnailPublisher.cs"),
    (Join-Path $here "PluginSrc\TowerVesselCallsignGui.cs"),
    (Join-Path $here "PluginSrc\TowerVesselCallsignStore.cs"),
    (Join-Path $here "PluginSrc\TowerVesselCallsignWatcher.cs"),
    (Join-Path $here "PluginSrc\TowerGhostFleet.cs"),
    (Join-Path $here "PluginSrc\TowerJumpToWindow.cs"),
    (Join-Path $here "PluginSrc\TowerCraftMode.cs"),
    (Join-Path $here "PluginSrc\TowerChecklistDefaults.cs"),
    (Join-Path $here "PluginSrc\TowerChecklistGui.cs"),
    (Join-Path $here "PluginSrc\TowerNotesGui.cs")
)
# Compile to dev\obj first so csc never writes straight into Plugins\ (KSP locks that DLL while running).
$outFinal = Join-Path $gameDataMod "Plugins\KSCTowerNetwork.Client.dll"
$objDir = Join-Path $here "obj"
$stagingDll = Join-Path $objDir "KSCTowerNetwork.Client.dll"

if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
if (-not (Test-Path $managed)) { throw "KSP managed dir not found: $managed (is `$kspRoot=$kspRoot wrong?)" }
foreach ($f in $src) {
    if (-not (Test-Path $f)) { throw "Source not found: $f" }
}

# Anything in this list under GameData\KSCTowerNetwork\ will fail the build.
# These trigger KSP's GameDatabase asset scanner at boot and break Localizer.
function Test-GameDataHygiene {
    param([string]$ModRoot)
    if (-not (Test-Path $ModRoot)) { return }

    # Scripts\ holds tiny .ks files that TowerAcarsKosBridge auto-deploys to the
    # kOS Archive on first run; KSP itself does not parse .ks as a cfg so it is
    # cheap to leave in place.
    $allowedDirs  = @('Plugins','Patches','Props','PluginData','Localization','Scripts')
    $allowedFiles = @()  # nothing should sit at the top level of the mod

    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($entry in Get-ChildItem -Force $ModRoot) {
        $isDir = $entry.PSIsContainer
        $allowed = if ($isDir) { $allowedDirs -contains $entry.Name } else { $allowedFiles -contains $entry.Name }
        if (-not $allowed) {
            $kind = if ($isDir) { 'folder' } else { 'file  ' }
            $bad.Add("  - $kind $($entry.Name)") | Out-Null
        }
    }

    if ($bad.Count -gt 0) {
        $msg  = "GameData hygiene check failed for $ModRoot`n"
        $msg += "Disallowed entries (move them to $here, OUTSIDE GameData):`n"
        $msg += ($bad -join "`n")
        $msg += "`n`nKSP scans every file under GameData. Source code, node_modules,"
        $msg += "`nbuilt web bundles and planning docs all make GameDatabase"
        $msg += "`nload take 25+s and break the localizer (everything renders as"
        $msg += "`n#autoLOC_xxxxx). Only Plugins\, Patches\, Props\, PluginData\,"
        $msg += "`nLocalization\ are allowed under the mod folder."
        throw $msg
    }
}

Test-GameDataHygiene -ModRoot $gameDataMod

$refs = @(
    "Assembly-CSharp.dll",
    "UnityEngine.dll",
    "UnityEngine.CoreModule.dll",
    "UnityEngine.AudioModule.dll",
    "UnityEngine.UIModule.dll",
    "UnityEngine.IMGUIModule.dll",
    "UnityEngine.TextRenderingModule.dll",
    "UnityEngine.UI.dll",
    "UnityEngine.UnityWebRequestModule.dll",
    "UnityEngine.UnityWebRequestAudioModule.dll",
    "UnityEngine.InputLegacyModule.dll",
    "UnityEngine.JSONSerializeModule.dll",
    "UnityEngine.PhysicsModule.dll",
    "UnityEngine.ImageConversionModule.dll"
) | ForEach-Object { "/reference:`"$managed\$_`"" }

$refs += "/reference:`"$fx\System.dll`""

$pluginsDir = Split-Path -Parent $outFinal
if (-not (Test-Path $objDir)) { New-Item -ItemType Directory -Path $objDir | Out-Null }
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }

$defines = @()
if ($Dev) { $defines += "/define:DEV_AUTOFILL" }

$srcQuoted = $src | ForEach-Object { "`"$_`"" }
# A response file keeps quoted paths consistent across Windows PowerShell and PowerShell 7.
$responsePath = Join-Path $objDir "plugin-build.rsp"
$compilerArgs = @("/target:library", "/optimize+", "/out:`"$stagingDll`"") + $defines + $refs + $srcQuoted
[IO.File]::WriteAllLines($responsePath, $compilerArgs, [Text.UTF8Encoding]::new($false))
& $csc "@$responsePath"
if ($LASTEXITCODE -ne 0) {
    throw "csc failed (see compiler output above)."
}
try {
    Copy-Item -LiteralPath $stagingDll -Destination $outFinal -Force -ErrorAction Stop
} catch {
    throw @"
Compiled OK: $stagingDll
Copy to GameData failed: $outFinal
$_

Quit KSP (it locks Plugins\KSCTowerNetwork.Client.dll), rerun build-plugin.ps1, or copy the staging DLL over the deployed one by hand.
"@
}

# MHz strip is procedural 7-segment text in TowerRadioGui (no bundled LCD .ttf).

# Re-run hygiene after build in case csc emitted a stray *.pdb next to the dll.
Test-GameDataHygiene -ModRoot $gameDataMod

if ($Dev) {
    Write-Host "Built (DEV_AUTOFILL): $outFinal"
    Write-Host "  Login will auto-fill: pilot@ksc.local / pilot12345 / callsign=fooney"
} else {
    Write-Host "Built: $outFinal"
}
