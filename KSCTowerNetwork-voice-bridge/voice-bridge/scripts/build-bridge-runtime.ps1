param(
    # Optional: defaults to portable bridge-runtime node (from ensure-bridge-node.ps1), then common installs.
    [string]$NodeExePath = "",
    [string]$SessionId = "dev-shared",
    [string]$TowerApiBase = "http://127.0.0.1:48787/v1",
    [int]$PcmPort = 47372,
    [int]$CtlPort = 47373
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
$bridgeRoot = Join-Path $projectRoot "voice-bridge"
$kspRoot = Split-Path -Path $projectRoot -Parent
$runtimeRoot = Join-Path $kspRoot "GameData\KSCTowerNetwork\PluginData\bridge-runtime"
$runtimeApp = Join-Path $runtimeRoot "app"
$runtimeNode = Join-Path $runtimeRoot "node"

if ([string]::IsNullOrWhiteSpace($NodeExePath)) {
    $candidates = @(
        (Join-Path $runtimeNode "node.exe"),
        (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
        "C:\Program Files\nodejs\node.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            $NodeExePath = $c
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($NodeExePath) -or -not (Test-Path -LiteralPath $NodeExePath)) {
    throw @"
Node runtime not found. Either:
  1) Run KSCTowerNetwork-dev\scripts\ensure-bridge-node.ps1 (downloads portable node into bridge-runtime\node\), then re-run this script, or
  2) Pass -NodeExePath 'C:\Program Files\nodejs\node.exe' (or your Node install path).
"@
}

# If the source node lives under runtimeRoot, stash a copy — the next step deletes runtimeRoot.
try {
    $fullSrc = (Resolve-Path -LiteralPath $NodeExePath).Path
    if ((Test-Path -LiteralPath $runtimeRoot)) {
        $fullRt = (Resolve-Path -LiteralPath $runtimeRoot).Path
        if ($fullSrc.StartsWith($fullRt, [StringComparison]::OrdinalIgnoreCase)) {
            $stash = Join-Path $env:TEMP "ksctower-build-node-stash.exe"
            Copy-Item -LiteralPath $NodeExePath -Destination $stash -Force
            $NodeExePath = $stash
            Write-Host "Stashed bundled node.exe for rebuild (source was inside runtimeRoot)."
        }
    }
} catch {
    # Resolve-Path can fail if path odd; ignore stash
}

$nodeDir = Split-Path -Path $NodeExePath -Parent
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path -LiteralPath $npmCmd)) {
    throw "npm.cmd not found next to node.exe at '$npmCmd'."
}

$env:Path = "$nodeDir;$env:Path"

function Invoke-Npm {
    param(
        [string[]]$NpmArgs
    )
    & $npmCmd @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw "npm command failed: npm $($NpmArgs -join ' ')"
    }
}

if (Test-Path -LiteralPath $runtimeRoot) {
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Path $runtimeApp | Out-Null
New-Item -ItemType Directory -Path $runtimeNode | Out-Null

# Build bridge once from source tree.
Push-Location $bridgeRoot
try {
    Invoke-Npm -NpmArgs @("run", "build")
}
finally {
    Pop-Location
}

# Stage runtime app and install production deps only.
Copy-Item -LiteralPath (Join-Path $bridgeRoot "package.json") -Destination (Join-Path $runtimeApp "package.json")
Copy-Item -LiteralPath (Join-Path $bridgeRoot "package-lock.json") -Destination (Join-Path $runtimeApp "package-lock.json")
Copy-Item -LiteralPath (Join-Path $bridgeRoot "dist") -Destination (Join-Path $runtimeApp "dist") -Recurse

Push-Location $runtimeApp
try {
    # Runtime image is production-only; skip lifecycle scripts here because we
    # manually overlay the already-patched rtc-node files below.
    Invoke-Npm -NpmArgs @("ci", "--omit=dev", "--ignore-scripts")
}
finally {
    Pop-Location
}

# Overlay @livekit/rtc-node fix for duplicate participantConnected FFI events (crashes with
# "Participant already exists"). Dev tree must have run `npm install` so patch-package applied.
$patchedLkRoomCjs = Join-Path $bridgeRoot "node_modules\@livekit\rtc-node\dist\room.cjs"
if (-not (Test-Path -LiteralPath $patchedLkRoomCjs)) {
    throw "LiveKit rtc-node dist/room.cjs is missing. Run npm ci in voice-bridge before building."
}
$patchedRoomText = Get-Content -LiteralPath $patchedLkRoomCjs -Raw
if (-not $patchedRoomText.Contains('duplicate identity') -or -not $patchedRoomText.Contains('failed to dispose user data handle')) {
    throw "LiveKit rtc-node crash guards are missing. Run npm run postinstall in voice-bridge before building."
}
$rtLkCjs = Join-Path $runtimeApp "node_modules\@livekit\rtc-node\dist\room.cjs"
Copy-Item -LiteralPath $patchedLkRoomCjs -Destination $rtLkCjs -Force
Write-Host "LiveKit rtc-node: overlaid participant and data-handle crash guards into runtime."

# Copy portable node runtime.
Copy-Item -LiteralPath $NodeExePath -Destination (Join-Path $runtimeNode "node.exe")

$startCmd = @"
@echo off
setlocal
set ROOT=%~dp0
if not defined SESSION_ID set SESSION_ID=$SessionId
if not defined TOWER_API_BASE set TOWER_API_BASE=$TowerApiBase
if not defined PCM_PORT set PCM_PORT=$PcmPort
if not defined CTL_PORT set CTL_PORT=$CtlPort
if not defined KSP_WATCHDOG set KSP_WATCHDOG=1
if not defined KSP_PROCESS_NAME set KSP_PROCESS_NAME=KSP_x64.exe

if not exist "%ROOT%node\node.exe" (
  echo [voice-bridge] FATAL: %ROOT%node\node.exe is missing. 1>&2
  echo [voice-bridge] This release was packaged without the bundled Node runtime. 1>&2
  echo [voice-bridge] Re-run scripts\build-bridge-runtime.ps1 -NodeExePath ^<path to node.exe^> 1>&2
  echo [voice-bridge] or download a Windows x64 node.exe from https://nodejs.org/dist/ 1>&2
  echo [voice-bridge] and place it at %ROOT%node\node.exe 1>&2
  exit /b 87
)

if not exist "%ROOT%app\dist\bridge.js" (
  echo [voice-bridge] FATAL: %ROOT%app\dist\bridge.js is missing. 1>&2
  echo [voice-bridge] The bridge app was not built into this release. 1>&2
  exit /b 88
)

"%ROOT%node\node.exe" "%ROOT%app\dist\bridge.js"
"@
Set-Content -LiteralPath (Join-Path $runtimeRoot "start-bridge.cmd") -Value $startCmd -Encoding ASCII

$readme = @"
KSCTowerNetwork voice bridge runtime
====================================

This folder is launched by the KSCTowerNetwork KSP plugin at game start.
You normally do not need to touch anything here.

Layout
------
  start-bridge.cmd       Launcher invoked by the plugin.
  node/node.exe          Bundled portable Node runtime (Windows x64).
  app/dist/bridge.js     Compiled bridge that talks to LiveKit and feeds PCM
                         audio to KSP over loopback TCP.
  app/node_modules/      Production-only Node dependencies.

Configuration
-------------
The plugin reads ../settings.cfg. See settings.example.cfg next to it for the
full list of keys; the bridge-relevant ones are:
  autoStartVoiceBridge = True
  bridgeExecutable = GameData/KSCTowerNetwork/PluginData/bridge-runtime/start-bridge.cmd
  bridgeWorkingDirectory = GameData/KSCTowerNetwork/PluginData/bridge-runtime
  towerApiHost / towerApiPort / towerApiPath / towerApiTls

Lifecycle
---------
The bridge runs only while KSP is running. KSP_WATCHDOG inside bridge.js polls
for KSP_x64.exe every 5s; after ~15s without it the bridge cleanly disconnects
from LiveKit and exits.

Troubleshooting
---------------
- "FATAL: ...node.exe is missing": this release was packaged without the
  bundled Node runtime. Rebuild via build-bridge-runtime.ps1 or drop a Windows
  x64 node.exe at node/node.exe.
- "token fetch attempt N/40 failed": the backend at TOWER_API_BASE is not
  reachable. Check towerApiHost/towerApiPort in settings.cfg.
- ksp_bridge persists in LiveKit Participants list with KSP closed: only
  happens if the bridge was launched outside KSP (e.g. dev npm run dev) so
  the watchdog has nothing to watch.

Generated by KSCTowerNetwork-voice-bridge/voice-bridge/scripts/build-bridge-runtime.ps1
"@
Set-Content -LiteralPath (Join-Path $runtimeRoot "README.txt") -Value $readme -Encoding ASCII

Write-Host "Bridge runtime packaged at: $runtimeRoot"
