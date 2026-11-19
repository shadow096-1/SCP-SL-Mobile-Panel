$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Missing runtime\node.exe. Download the complete package again.' }
$secret = Read-Host 'Set panel admin password (6+ characters)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $env:SCP_PANEL_SETUP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($env:SCP_PANEL_SETUP_PASSWORD.Length -lt 6) { throw 'Password must contain at least 6 characters.' }
    & $node .\setup.js
    if ($LASTEXITCODE -ne 0) { throw 'Setup failed.' }
} finally {
    Remove-Item Env:SCP_PANEL_SETUP_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
