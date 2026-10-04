#requires -Version 5.1
<#
.SYNOPSIS
  Package a release-ready ZIP of GameData/KSCTowerNetwork for end users.

.DESCRIPTION
  Reads release-config.json (single source of truth for hostnames) and produces
  TWO outputs:

    A) release/KSCTowerNetwork-<ver>.zip
       The player-facing mod download. Contains GameData/KSCTowerNetwork/ with
       the plugin, the bundled bridge runtime, parts, and a settings.cfg whose
       hostname is baked in from release-config.json. Does NOT contain backend
       or web sources; those live on your servers, not the player's PC.

    B) release/web-dist-<ver>/
       The built web SPA, with VITE_API_BASE pinned to the configured backend
       origin (or empty for single-origin deployments). Deploy this folder to
       Cloudflare Pages / Vercel / Netlify / your reverse proxy.

  Steps:
    1. Verifies bridge runtime has been built (node.exe + bridge.js).
    2. Builds the web SPA (from KSCTowerNetwork-dev/web, -WebSourcePath, or GameData/.../web) with VITE_API_BASE -> output (B).
    3. Stages a clean GameData/KSCTowerNetwork into release/staging-<ver>/.
    4. Bakes hostnames into staged settings.cfg + start-bridge.cmd.
    5. Strips dev-only files (sources, *.ts, .env, auth.cfg, web/, backend/).
    6. Writes RELEASE_MANIFEST.txt with SHA256 of the binaries.
    7. Zips the staged tree into output (A).

  This script does NOT build the bridge runtime; run scripts/build-bridge-runtime.ps1
  first. It refuses to package if node.exe or bridge.js are missing, because
  the resulting ZIP would silently fail for end users.

.PARAMETER ConfigPath
  Path to release-config.json. Defaults to GameData/KSCTowerNetwork/release-config.json.
  Falls back to release-config.example.json with a warning if the real file is missing.

.PARAMETER Version
  Release version. If unset, taken from release-config.json's "version" field.

.PARAMETER NodeExePath
  Optional path to node.exe used to run `npm run build` for the web. Defaults to
  whichever `node` is on PATH.

.PARAMETER WebSourcePath
  Directory containing the Vite web app (package.json, vite.config, src/).
  Defaults to KSCTowerNetwork-dev/web next to the KSP root when present; otherwise
  GameData/KSCTowerNetwork/web. Use this to avoid copying web sources into GameData.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -WebSourcePath "C:\path\to\KSCTowerNetwork-dev\web"
#>
param(
    [string]$ConfigPath = "",
    [string]$Version = "",
    [string]$NodeExePath = "",
    [string]$OutputDirectory = "",
    [string]$WebSourcePath = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
$kspRoot = Split-Path -Path $projectRoot -Parent
$gameDataMod = Join-Path $kspRoot "GameData\KSCTowerNetwork"

if (-not (Test-Path -LiteralPath $gameDataMod)) {
    throw "Mod folder not found: $gameDataMod"
}

# --- Load release-config.json --------------------------------------------------
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $gameDataMod "release-config.json"
}
$usingExample = $false
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    $exampleConfig = Join-Path $gameDataMod "release-config.example.json"
    if (Test-Path -LiteralPath $exampleConfig) {
        Write-Warning "release-config.json not found; using release-config.example.json (placeholders will leak into the ZIP)."
        Write-Warning "Copy $exampleConfig to release-config.json and edit it before publishing."
        $ConfigPath = $exampleConfig
        $usingExample = $true
    } else {
        throw "Neither release-config.json nor release-config.example.json was found in $gameDataMod."
    }
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

if (-not $Version) { $Version = [string]$config.version }
if (-not $Version) { throw "Version not provided and not in release-config.json" }

$backendOriginRaw = [string]$config.backend.origin
$backendApiPathRaw = [string]$config.backend.apiPath
$webOrigin = [string]$config.web.origin
$sessionId = [string]$config.session.id
$liveKitWsUrl = [string]$config.livekit.wsUrl

if (-not $backendOriginRaw) { throw "release-config.json missing backend.origin" }
if (-not $backendApiPathRaw) { $backendApiPathRaw = "/v1" }
if (-not $webOrigin) { $webOrigin = $backendOriginRaw }
if (-not $sessionId) { $sessionId = "tower-public" }

# Parse backend origin into host/port/tls for the KSP-side settings.cfg.
$backendUri = [Uri]$backendOriginRaw
$towerHost = $backendUri.Host
$towerTls = ($backendUri.Scheme -eq "https")
if ($backendUri.IsDefaultPort) {
    $towerPort = if ($towerTls) { 443 } else { 80 }
} else {
    $towerPort = $backendUri.Port
}
$towerApiPath = $backendApiPathRaw
if (-not $towerApiPath.StartsWith("/")) { $towerApiPath = "/$towerApiPath" }

# Build the absolute URL the bridge / web hit. Drop the port segment when it
# matches the scheme default so the URL reads cleanly (https://host/v1).
$portSegment = if ($backendUri.IsDefaultPort) { "" } else { ":" + $towerPort }
$towerApiBaseUrl = "{0}://{1}{2}{3}" -f $backendUri.Scheme, $towerHost, $portSegment, $towerApiPath

Write-Host "Release config:"
Write-Host "  Version:           $Version"
Write-Host "  Backend origin:    $backendOriginRaw  ->  host=$towerHost port=$towerPort tls=$towerTls path=$towerApiPath"
Write-Host "  Web origin:        $webOrigin"
Write-Host "  Default sessionId: $sessionId"
Write-Host "  LiveKit WS URL:    $liveKitWsUrl"
if ($usingExample) { Write-Host "  WARNING: using example config, do not publish this ZIP." -ForegroundColor Yellow }
Write-Host ""

# --- Preflight: bridge runtime must be packaged --------------------------------
$runtime = Join-Path $gameDataMod "PluginData\bridge-runtime"
$mustExist = @(
    (Join-Path $runtime "node\node.exe"),
    (Join-Path $runtime "app\dist\bridge.js"),
    (Join-Path $runtime "start-bridge.cmd"),
    (Join-Path $gameDataMod "Plugins\KSCTowerNetwork.Client.dll"),
    (Join-Path $gameDataMod "PluginData\settings.example.cfg")
)
$missing = @()
foreach ($p in $mustExist) {
    if (-not (Test-Path -LiteralPath $p)) { $missing += $p }
}
if ($missing.Count -gt 0) {
    Write-Error "Refusing to package release: required files are missing."
    foreach ($m in $missing) { Write-Host "  MISSING: $m" }
    Write-Host ""
    Write-Host "If node.exe is missing, run scripts\build-bridge-runtime.ps1 first."
    Write-Host "If bridge.js is missing, run npm run build in voice-bridge/."
    Write-Host "If KSCTowerNetwork.Client.dll is missing, build the C# plugin first."
    exit 1
}

# --- Build web SPA with VITE_API_BASE pinned ----------------------------------
$devWebDefault = Join-Path $kspRoot "KSCTowerNetwork-dev\web"
$gameDataWeb = Join-Path $gameDataMod "web"
if ($WebSourcePath) {
    $webRoot = $WebSourcePath
} elseif (Test-Path -LiteralPath (Join-Path $devWebDefault "package.json")) {
    $webRoot = $devWebDefault
    Write-Host "Using web sources from repo: $webRoot"
} elseif (Test-Path -LiteralPath (Join-Path $gameDataWeb "package.json")) {
    $webRoot = $gameDataWeb
    Write-Host "Using web sources from mod folder: $webRoot"
} else {
    throw "Web app not found. Pass -WebSourcePath to KSCTowerNetwork-dev/web (or copy web/ under GameData/KSCTowerNetwork/). Expected package.json in one of: $devWebDefault | $gameDataWeb"
}
$webDist = Join-Path $webRoot "dist"

if (-not $NodeExePath) {
    $nodeOnPath = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeOnPath) { $NodeExePath = $nodeOnPath.Source }
}
if (-not $NodeExePath -or -not (Test-Path -LiteralPath $NodeExePath)) {
    throw "node.exe not found. Pass -NodeExePath or put node on PATH so the web build can run."
}
$nodeDir = Split-Path -Path $NodeExePath -Parent
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path -LiteralPath $npmCmd)) { throw "npm.cmd not found next to $NodeExePath" }
$env:Path = "$nodeDir;$env:Path"

# When web and backend share an origin, leave VITE_API_BASE empty so the SPA uses
# relative /v1 paths (works behind a reverse proxy without a code change).
$viteApiBase = if ($webOrigin -eq $backendOriginRaw) { "" } else { $towerApiBaseUrl }
$env:VITE_API_BASE = $viteApiBase

Write-Host "Building web SPA (VITE_API_BASE='$viteApiBase')..."
Push-Location $webRoot
try {
    & $npmCmd "ci" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed in web/" }
    & $npmCmd "run" "build" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in web/" }
} finally {
    Pop-Location
    Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath (Join-Path $webDist "index.html"))) {
    throw "web build did not produce dist/index.html"
}

# Copy the built SPA out as a separate deployable artifact (B). Players never
# see this; you deploy it to Cloudflare Pages / Vercel / Netlify / your proxy.
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $kspRoot "release" }
if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
}
$webOut = Join-Path $OutputDirectory ("web-dist-" + $Version)
if (Test-Path -LiteralPath $webOut) { Remove-Item -LiteralPath $webOut -Recurse -Force }
Copy-Item -LiteralPath $webDist -Destination $webOut -Recurse

# --- Stage a clean copy of the mod tree ---------------------------------------
$staging = Join-Path $OutputDirectory ("staging-" + $Version)
if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging | Out-Null
$stagedGameData = Join-Path $staging "GameData\KSCTowerNetwork"
New-Item -ItemType Directory -Path $stagedGameData -Force | Out-Null

# Robocopy with absolute exclude paths so we don't accidentally strip
# similarly-named folders nested inside node_modules.
$excludeDirs = @(
    (Join-Path $gameDataMod "backend"),
    (Join-Path $gameDataMod "web"),
    (Join-Path $gameDataMod ".vite")
)
# File excludes are matched by basename anywhere in the tree. *.ts / *.tsx /
# *.map only exist inside source trees and node_modules type-decls, neither of
# which Node loads at runtime, so stripping them slims the ZIP without harm.
$excludeFiles = @(
    "*.ts",
    "*.tsx",
    "*.map",
    "tsconfig*.json",
    "vite.config.*",
    ".env",
    ".env.*",
    "*.log",
    "auth.cfg",
    "settings.cfg",
    "release-config.json",
    "release-config.example.json"
)

$rcArgs = @(
    "$gameDataMod", "$stagedGameData", "/E",
    "/XD"
) + $excludeDirs + @("/XF") + $excludeFiles + @(
    "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"
)
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

# --- Generate the user-facing settings.cfg with hostnames baked in -------------
$settingsCfg = @"
// KSCTowerNetwork user settings (generated by package-release.ps1 v$Version).
//
// You can edit this file. The plugin only reads it; it never overwrites it.
// Auth tokens live separately in PluginData/auth.cfg.
//
// IMPORTANT: KSP's ConfigNode parser strips everything after `//` in a value,
// so use the split host/port/path keys below instead of a full URL.
KSCTOWERNETWORK
{
	// --- Tower backend (set at release time from release-config.json) ----------
	towerApiHost = $towerHost
	towerApiPort = $towerPort
	towerApiPath = $towerApiPath
	towerApiTls  = $towerTls

	// --- Default channel ------------------------------------------------------
	sessionId = $sessionId

	// --- Local voice plumbing (bridge <-> KSP over loopback) ------------------
	voiceListenHost = 127.0.0.1
	voiceListenPort = 47372
	voiceCtlHost = 127.0.0.1
	voiceCtlPort = 47373

	// --- UX -------------------------------------------------------------------
	pushToTalkKey = V
	skipTowerLogin = False
	rememberTowerEmail = True
	persistTowerSessionToken = True
	autoConnectDelaySeconds = 3
	autoConnectVoiceListen = True
	autoBridgeMicAfterListen = False

	// --- Voice bridge auto-launch ---------------------------------------------
	autoStartVoiceBridge = True
	bridgeExecutable = GameData/KSCTowerNetwork/PluginData/bridge-runtime/start-bridge.cmd
	bridgeWorkingDirectory = GameData/KSCTowerNetwork/PluginData/bridge-runtime
	bridgeArguments =
	bridgeEnv_BRIDGE_IDENTITY = ksp_bridge
}
"@
$settingsCfgPath = Join-Path $stagedGameData "PluginData\settings.cfg"
Set-Content -LiteralPath $settingsCfgPath -Value $settingsCfg -Encoding UTF8

# Also regenerate start-bridge.cmd with the production TOWER_API_BASE baked in,
# so a player who launches it standalone (outside the plugin) hits the right host.
$startCmd = @"
@echo off
setlocal
set ROOT=%~dp0
if not defined SESSION_ID set SESSION_ID=$sessionId
if not defined TOWER_API_BASE set TOWER_API_BASE=$towerApiBaseUrl
if not defined PCM_PORT set PCM_PORT=47372
if not defined CTL_PORT set CTL_PORT=47373
if not defined KSP_WATCHDOG set KSP_WATCHDOG=1
if not defined KSP_PROCESS_NAME set KSP_PROCESS_NAME=KSP_x64.exe

if not exist "%ROOT%node\node.exe" (
  echo [voice-bridge] FATAL: %ROOT%node\node.exe is missing. 1>&2
  echo [voice-bridge] This release was packaged without the bundled Node runtime. 1>&2
  exit /b 87
)

if not exist "%ROOT%app\dist\bridge.js" (
  echo [voice-bridge] FATAL: %ROOT%app\dist\bridge.js is missing. 1>&2
  exit /b 88
)

"%ROOT%node\node.exe" "%ROOT%app\dist\bridge.js"
"@
Set-Content -LiteralPath (Join-Path $stagedGameData "PluginData\bridge-runtime\start-bridge.cmd") -Value $startCmd -Encoding ASCII

# --- Manifest + zip ------------------------------------------------------------
$nodeExe = Join-Path $stagedGameData "PluginData\bridge-runtime\node\node.exe"
$bridgeJs = Join-Path $stagedGameData "PluginData\bridge-runtime\app\dist\bridge.js"
$dll = Join-Path $stagedGameData "Plugins\KSCTowerNetwork.Client.dll"

$nodeHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash
$bridgeHash = (Get-FileHash -LiteralPath $bridgeJs -Algorithm SHA256).Hash
$dllHash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash

$manifest = @"
KSCTowerNetwork release $Version
Built:           $(Get-Date -Format o)
Backend origin:  $backendOriginRaw
Web origin:      $webOrigin
LiveKit WS URL:  $liveKitWsUrl
Session id:      $sessionId

SHA256 (node.exe):                   $nodeHash
SHA256 (bridge.js):                  $bridgeHash
SHA256 (KSCTowerNetwork.Client.dll): $dllHash
"@
$manifestPath = Join-Path $stagedGameData "RELEASE_MANIFEST.txt"
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding ASCII

$zipPath = Join-Path $OutputDirectory ("KSCTowerNetwork-" + $Version + ".zip")
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "GameData") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Release packaged:"
Write-Host "  Player ZIP (A):   $zipPath"
Write-Host "  Web bundle (B):   $webOut  (deploy this to your CDN/Pages/Vercel)"
Write-Host "  Staging tree:     $staging"
Write-Host ""
Write-Host $manifest
if ($usingExample) {
    Write-Host ""
    Write-Warning "Example config was used. The ZIP contains placeholder hostnames and is for testing only."
}
