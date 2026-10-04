# Compiles and runs unit tests for TowerVoiceListenUiLogic (no KSP / Unity).
# Run from repo root or this folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File KSCTowerNetwork-dev/plugin-tests/run-listen-ui-tests.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fx = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fx "csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }

$logicSrc = Join-Path $here "..\PluginSrc\TowerVoiceListenUiLogic.cs"
$testSrc = Join-Path $here "TowerVoiceListenUiLogicTests.cs"
$outDir = Join-Path $here "obj"
$dll = Join-Path $outDir "TowerVoiceListenUiLogic.dll"
$exe = Join-Path $outDir "TowerVoiceListenUiLogicTests.exe"

foreach ($f in @($logicSrc, $testSrc)) {
    if (-not (Test-Path $f)) { throw "Source not found: $f" }
}
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

& $csc /target:library /optimize+ "/out:$dll" "/reference:$fx\System.dll" "`"$logicSrc`""
if ($LASTEXITCODE -ne 0) { throw "csc library failed" }

& $csc /target:exe /optimize+ "/out:$exe" "/reference:$fx\System.dll" "/reference:$dll" "`"$testSrc`""
if ($LASTEXITCODE -ne 0) { throw "csc exe failed" }

& $exe
if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit $LASTEXITCODE" }
Write-Host "OK: plugin-tests listen UI logic"
