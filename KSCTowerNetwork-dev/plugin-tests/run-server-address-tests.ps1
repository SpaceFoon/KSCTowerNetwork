# Address parsing uses the same .NET Framework as the KSP plugin, without Unity.
param([string]$KspManagedPath)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$fx = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fx "csc.exe"
$outDir = Join-Path $here "obj"
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$exe = Join-Path $outDir "TowerServerAddressTests.exe"
& $csc /target:exe /optimize+ "/out:$exe" "/reference:$fx\System.dll" (Join-Path $here "..\PluginSrc\TowerServerAddress.cs") (Join-Path $here "TowerServerAddressTests.cs")
if ($LASTEXITCODE -ne 0) { throw "Server address test compilation failed" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "Server address tests failed" }

if ($KspManagedPath) {
    $plugin = Join-Path $here "..\obj\KSCTowerNetwork.Client.dll"
    $persistenceExe = Join-Path $outDir "TowerServerPersistenceTests.exe"
    & $csc /target:exe /optimize+ "/out:$persistenceExe" "/reference:$plugin" "/reference:$KspManagedPath\Assembly-CSharp.dll" "/reference:$KspManagedPath\UnityEngine.CoreModule.dll" (Join-Path $here "TowerServerPersistenceTests.cs")
    if ($LASTEXITCODE -ne 0) { throw "Server persistence test compilation failed; build the plugin first" }
    & $persistenceExe $plugin $KspManagedPath (Join-Path $outDir "server-address-roundtrip.cfg")
    if ($LASTEXITCODE -ne 0) { throw "Server persistence tests failed" }
}
