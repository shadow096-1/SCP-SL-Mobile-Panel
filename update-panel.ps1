param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$DataDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$allowed = @(
    'server.js', 'storage.js', 'game.js', 'players.js', 'plugins.js', 'updater.js',
    'package.json', 'README.md', 'start.ps1', 'setup.ps1', 'setup.js',
    'public-ip.ps1', 'PUBLIC-IP.cmd', 'START-HERE.cmd', 'config.ps1.example',
    'public/index.html', 'public/app.js', 'public/manage.js',
    'public/config-editor.js', 'public/style.css', 'update-panel.ps1'
)
$required = @('package.json', 'server.js', 'start.ps1', 'public/index.html', 'players.js', 'updater.js', 'update-panel.ps1')
$allowedSet = @{}
foreach ($name in $allowed) { $allowedSet[$name] = $true }

$install = [IO.Path]::GetFullPath($InstallDir)
$data = [IO.Path]::GetFullPath($DataDir)
$archivePath = [IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath (Join-Path $install 'package.json'))) { throw 'Panel installation not found.' }
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Update archive not found.' }
New-Item -ItemType Directory -Path $data -Force | Out-Null
$stage = Join-Path $data ('update-stage-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path (Join-Path $data 'panel-update-backups') ((Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedStage = [IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith($data + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path.' }
$replaced = New-Object System.Collections.Generic.List[string]
$created = New-Object System.Collections.Generic.List[string]

try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $archiveObject = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $selected = @{}
        $totalBytes = 0L
        foreach ($entry in $archiveObject.Entries) {
            $entryName = $entry.FullName.Replace('\', '/')
            $relative = if ($allowedSet.ContainsKey($entryName)) { $entryName } else {
                $parts = $entryName.Split('/', 2)
                if ($parts.Length -eq 2 -and $allowedSet.ContainsKey($parts[1])) { $parts[1] } else { $null }
            }
            if (-not $relative) { continue }
            if ($selected.ContainsKey($relative)) { throw "Duplicate update entry: $relative" }
            if ($entry.Length -gt 2MB -or $entry.Length -lt 0) { throw 'Update file is too large.' }
            $totalBytes += $entry.Length
            if ($totalBytes -gt 8MB) { throw 'Update contents are too large.' }
            $selected[$relative] = $true
            $target = Join-Path $stage ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
            $parent = Split-Path -Parent $target
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            $sourceStream = $entry.Open()
            $targetStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $buffer = New-Object byte[] 65536
                $written = 0L
                while (($count = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $count
                    if ($written -gt 2MB) { throw 'Update file is too large.' }
                    $targetStream.Write($buffer, 0, $count)
                }
            } finally {
                $targetStream.Dispose()
                $sourceStream.Dispose()
            }
        }
        foreach ($name in $required) { if (-not $selected.ContainsKey($name)) { throw "Missing update file: $name" } }
        $incoming = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $installed = Get-Content -LiteralPath (Join-Path $install 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($incoming.name -ne 'scp-sl-mobile-panel') { throw 'Invalid panel package.' }
        $nextVersion = [version]$incoming.version
        $currentVersion = [version]$installed.version
        if ($nextVersion -lt $currentVersion) { throw 'Update version is older than the installed version.' }
        $node = Join-Path $install 'runtime\node.exe'
        foreach ($name in $selected.Keys) {
            if ($name.EndsWith('.js')) {
                & $node --check (Join-Path $stage ($name.Replace('/', [IO.Path]::DirectorySeparatorChar)))
                if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax error: $name" }
            }
        }
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        foreach ($name in $selected.Keys) {
            $relativePath = $name.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $source = Join-Path $stage $relativePath
            $destination = Join-Path $install $relativePath
            $destinationParent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
            if (Test-Path -LiteralPath $destination) {
                $backupFile = Join-Path $backup $relativePath
                New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
                Copy-Item -LiteralPath $destination -Destination $backupFile -Force
                $replaced.Add($name)
            } else { $created.Add($name) }
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
        Write-Output $incoming.version
    } finally { if ($archiveObject) { $archiveObject.Dispose() } }
} catch {
    foreach ($name in $replaced) {
        $relativePath = $name.Replace('/', [IO.Path]::DirectorySeparatorChar)
        Copy-Item -LiteralPath (Join-Path $backup $relativePath) -Destination (Join-Path $install $relativePath) -Force -ErrorAction SilentlyContinue
    }
    foreach ($name in $created) {
        $relativePath = $name.Replace('/', [IO.Path]::DirectorySeparatorChar)
        Remove-Item -LiteralPath (Join-Path $install $relativePath) -Force -ErrorAction SilentlyContinue
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
