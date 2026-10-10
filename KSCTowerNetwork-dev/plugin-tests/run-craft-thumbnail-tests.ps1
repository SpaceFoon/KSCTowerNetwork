$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testOutput = Join-Path $here 'obj'
New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
$testExe = Join-Path $testOutput 'TowerCraftThumbnailPathsTests.exe'
$pureSource = Join-Path $here '..\PluginSrc\TowerCraftThumbnailPaths.cs'
$testSource = Join-Path $here 'TowerCraftThumbnailPathsTests.cs'
& $compiler /target:exe "/out:$testExe" $pureSource $testSource
if ($LASTEXITCODE -ne 0) { throw 'Thumbnail path test compile failed' }
& $testExe
if ($LASTEXITCODE -ne 0) { throw 'Thumbnail path tests failed' }
