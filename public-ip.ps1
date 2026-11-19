param(
    [string]$PublicIp,
    [switch]$SkipFirewall,
    [switch]$SetupOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$config = Join-Path $PSScriptRoot 'config.ps1'
if (Test-Path -LiteralPath $config) { . $config }
$dataDir = if ($env:SCP_PANEL_DATA_DIR) { $env:SCP_PANEL_DATA_DIR } else { Join-Path $PSScriptRoot 'data' }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$statePath = Join-Path $dataDir 'public-ip.json'
$pfxPath = Join-Path $dataDir 'public-ip.pfx'
$cerPath = Join-Path $dataDir 'public-ip.cer'
$state = $null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
}

if (-not $PublicIp) {
    $PublicIp = if ($state -and $state.ip) { [string]$state.ip } else { Read-Host 'Enter server public IPv4 address' }
}
$parsedIp = $null
if (-not [Net.IPAddress]::TryParse($PublicIp, [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'PublicIp must be an IPv4 address.'
}

$needsCertificate = -not $state -or $state.ip -ne $PublicIp -or
    -not (Test-Path -LiteralPath $pfxPath) -or
    ([datetime]$state.expires) -lt (Get-Date).AddDays(30)
if (-not $needsCertificate) {
    try { $securePassword = ConvertTo-SecureString -String $state.protectedPassword }
    catch { $needsCertificate = $true }
}

if ($needsCertificate) {
    Write-Host "Creating HTTPS certificate for $PublicIp ..." -ForegroundColor Cyan
    $certificate = New-SelfSignedCertificate -Type SSLServerAuthentication `
        -Subject "CN=$PublicIp" `
        -TextExtension @("2.5.29.17={text}IPAddress=$PublicIp") `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(1)

    $random = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $password = [Convert]::ToBase64String($random)
    $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
    Export-PfxCertificate -Cert $certificate -FilePath $pfxPath `
        -Password $securePassword -CryptoAlgorithmOption AES256_SHA256 -Force | Out-Null
    Export-Certificate -Cert $certificate -FilePath $cerPath -Force | Out-Null
    $state = @{
        ip = $PublicIp
        expires = $certificate.NotAfter.ToString('o')
        thumbprint = $certificate.Thumbprint
        protectedPassword = ConvertFrom-SecureString -SecureString $securePassword
    }
    $json = $state | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statePath, $json, (New-Object Text.UTF8Encoding $false))
} else {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$port = if ($env:SCP_PANEL_PORT) { [int]$env:SCP_PANEL_PORT } else { 3767 }
if ($port -lt 1 -or $port -gt 65535) { throw 'SCP_PANEL_PORT must be between 1 and 65535.' }
$ruleName = "SCP-SL Panel HTTPS $port"
if (-not $SkipFirewall -and -not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $port -Profile Any | Out-Null
        Write-Host "Windows Firewall now allows TCP port $port." -ForegroundColor Green
    } catch {
        Write-Warning "Could not open Windows Firewall port $port. Run this launcher as administrator or add the inbound rule manually."
    }
}

if ($SetupOnly) { return }

$env:SCP_PANEL_BIND = '0.0.0.0'
$env:SCP_PANEL_PORT = [string]$port
$env:SCP_PANEL_TLS_PFX = $pfxPath
$env:SCP_PANEL_TLS_PFX_PASSWORD = $password
Remove-Item Env:SCP_PANEL_TLS_CERT,Env:SCP_PANEL_TLS_KEY -ErrorAction SilentlyContinue

Write-Host "Phone URL: https://${PublicIp}:$port" -ForegroundColor Green
Write-Host "Certificate SHA-1 thumbprint: $($state.thumbprint)" -ForegroundColor Yellow
Write-Warning 'This certificate is self-signed. Your phone will show a certificate warning until you establish trust. Do not enter the admin password if the certificate fingerprint differs.'
Write-Host 'The hosting provider firewall must also allow the same TCP port.' -ForegroundColor Yellow
try { & (Join-Path $PSScriptRoot 'start.ps1') }
finally {
    Remove-Item Env:SCP_PANEL_TLS_PFX,Env:SCP_PANEL_TLS_PFX_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
}
