$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Missing runtime\node.exe. Download the complete package again.' }
$config = Join-Path $PSScriptRoot 'config.ps1'
if (Test-Path -LiteralPath $config) { . $config }
$dataDir = if ($env:SCP_PANEL_DATA_DIR) { $env:SCP_PANEL_DATA_DIR } else { Join-Path $PSScriptRoot 'data' }
$settings = Join-Path $dataDir 'settings.json'
if (-not (Test-Path -LiteralPath $settings)) {
    Write-Host 'First run: set the panel admin password.' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'setup.ps1')
}
Write-Host 'Starting SCP:SL panel. Keep this window open.' -ForegroundColor Cyan
$env:SCP_PANEL_LAUNCHER = '1'
while ($true) {
    & $node .\server.js
    if ($LASTEXITCODE -eq 42) {
        Write-Host 'Panel update installed. Restarting...' -ForegroundColor Cyan
        Start-Sleep -Seconds 1
        continue
    }
    if ($LASTEXITCODE -ne 0) { throw 'Panel failed to start. See the error above.' }
    break
}
