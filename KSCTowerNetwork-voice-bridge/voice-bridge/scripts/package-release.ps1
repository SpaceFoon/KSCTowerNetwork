#requires -Version 5.1
<#
.SYNOPSIS
Build and verify neutral client and server release ZIPs from a clean source commit.
.DESCRIPTION
Uses Node 24.22.1+ (24.x), npm, KSP assemblies and Windows x64 build tools.
Builds in isolated tracked-source staging; private local files are never copied.
The client is configured by each pilot; deployment-specific release-config is not used.
#>
param(
    [string]$KspManagedPath,
    [string]$Version,
    [string]$NodeExePath = 'node',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$releaseArgs = @((Join-Path $repoRoot 'KSCTowerNetwork-dev/scripts/package-release.mjs'))
if ($KspManagedPath) { $releaseArgs += @('--ksp-managed', $KspManagedPath) }
if ($Version) { $releaseArgs += @('--version', $Version) }
if ($OutputDirectory) { $releaseArgs += @('--output', $OutputDirectory) }
& $NodeExePath @releaseArgs
if ($LASTEXITCODE -ne 0) { throw 'Release build failed; no release should be published.' }
