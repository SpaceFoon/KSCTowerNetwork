[CmdletBinding()]
param(
    [ValidateSet('setup', 'build', 'start', 'help')][string]$Command = 'help',
    [string]$EnvFile
)
$ErrorActionPreference = 'Stop'
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node 22+ and npm before running the server scripts.' }
if ($EnvFile -and $Command -ne 'start') { throw '-EnvFile is only valid with start.' }
$serverArguments = @((Join-Path $PSScriptRoot 'server.mjs'))
if ($Command -eq 'help') { $serverArguments += '--help' } else { $serverArguments += $Command }
if ($EnvFile) { $serverArguments += @('--env-file', $EnvFile) }
& node @serverArguments
if ($LASTEXITCODE -ne 0) { throw 'Server command failed. See the message above.' }
