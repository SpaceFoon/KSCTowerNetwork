[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [string]$OutputPath,
    [string]$PythonCommand = 'python'
)
$ErrorActionPreference = 'Stop'
$webRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $webRoot '.chart-tools'
$environmentPython = Join-Path $environmentPath 'Scripts\python.exe'
if (!(Test-Path -LiteralPath $PdfPath -PathType Leaf)) { throw "PDF not found: $PdfPath" }
if (!(Get-Command $PythonCommand -ErrorAction SilentlyContinue)) { throw 'Install Python 3.10 or later, or pass -PythonCommand with its executable path.' }
if (!(Test-Path -LiteralPath $environmentPython)) {
    & $PythonCommand -m venv $environmentPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the chart installer Python environment.' }
}
& $environmentPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'chart-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install chart dependencies. Check internet access and the pip output.' }
$installerArguments = @((Join-Path $PSScriptRoot 'install_charts.py'), '--pdf', $PdfPath)
if ($OutputPath) { $installerArguments += @('--output', $OutputPath) }
& $environmentPython @installerArguments
if ($LASTEXITCODE -ne 0) { throw 'Chart installation failed. See the installer message above.' }
