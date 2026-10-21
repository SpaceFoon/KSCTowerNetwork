# Downloads Windows x64 node.exe into GameData/.../bridge-runtime/node/ when missing.
# Keeps the 80MB+ binary out of Git (see repo .gitignore). Safe to run repeatedly.
#
# Pinned dist matches voice-bridge package.json engines (Node 24+).
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Host "[ensure-bridge-node] Skipping: Windows-only (KSP bridge runtime)."
    exit 0
}

$NodeDistVersion = "v24.22.1"
$ZipName = "node-$NodeDistVersion-win-x64.zip"
$DistUrl = "https://nodejs.org/dist/$NodeDistVersion/$ZipName"

$here = $PSScriptRoot
$devRoot = Split-Path -Path $here -Parent
$kspRoot = Split-Path -Path $devRoot -Parent
$targetDir = Join-Path $kspRoot "GameData\KSCTowerNetwork\PluginData\bridge-runtime\node"
$targetExe = Join-Path $targetDir "node.exe"

if (Test-Path -LiteralPath $targetExe) {
    $len = (Get-Item -LiteralPath $targetExe).Length
    if ($len -gt 8MB) {
        $installedVersion = & $targetExe --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $installedVersion -eq $NodeDistVersion) {
            Write-Host "[ensure-bridge-node] OK: $targetExe already present ($installedVersion)."
            exit 0
        }
    }
}

$gameDataMod = Join-Path $kspRoot "GameData\KSCTowerNetwork"
if (-not (Test-Path -LiteralPath $gameDataMod)) {
    throw "[ensure-bridge-node] Expected mod folder missing: $gameDataMod (is KSCTowerNetwork-dev next to KSP root?)"
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$tmpRoot = Join-Path $env:TEMP "ksctower-node-fetch"
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$zipPath = Join-Path $tmpRoot $ZipName
$extractDir = Join-Path $tmpRoot "extract-$NodeDistVersion"

if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
}

Write-Host "[ensure-bridge-node] Downloading $DistUrl ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $DistUrl -OutFile $zipPath -UseBasicParsing

Write-Host "[ensure-bridge-node] Extracting..."
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

$innerExe = Join-Path $extractDir "node-$NodeDistVersion-win-x64\node.exe"
if (-not (Test-Path -LiteralPath $innerExe)) {
    throw "[ensure-bridge-node] Extracted layout unexpected; missing: $innerExe"
}

Copy-Item -LiteralPath $innerExe -Destination $targetExe -Force
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[ensure-bridge-node] Installed: $targetExe"
