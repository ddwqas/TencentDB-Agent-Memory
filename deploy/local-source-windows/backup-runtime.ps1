param(
    [string]$DestinationRoot = (Join-Path $PSScriptRoot '.runtime-backups'),
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

if (-not (Test-Path -LiteralPath $script:RuntimeDir -PathType Container)) {
    throw "Runtime directory does not exist: $script:RuntimeDir"
}

$sourceRuntime = [System.IO.Path]::GetFullPath($script:RuntimeDir)
$backupBase = [System.IO.Path]::GetFullPath($DestinationRoot)
if ($backupBase.StartsWith($sourceRuntime + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationRoot must not be inside .runtime.'
}

Write-Info 'Stopping all tracked services before the runtime backup'
Stop-TrackedProcesses

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupSet = Join-Path $backupBase $stamp
$backupRuntime = Join-Path $backupSet '.runtime'
if (Test-Path -LiteralPath $backupSet) {
    throw "Backup destination already exists: $backupSet"
}

try {
    New-Item -ItemType Directory -Path $backupSet -Force | Out-Null
    Write-Info "Copying the complete runtime to $backupRuntime"
    Copy-Item -LiteralPath $sourceRuntime -Destination $backupRuntime -Recurse -Force

    # -Force is required: Git clone directories are hidden on Windows, and Copy-Item
    # may not preserve the directory's Hidden attribute on the destination.
    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRuntime -File -Recurse -Force | Sort-Object FullName)
    $backupFiles = @(Get-ChildItem -LiteralPath $backupRuntime -File -Recurse -Force | Sort-Object FullName)
    if ($sourceFiles.Count -ne $backupFiles.Count) {
        throw "File count mismatch: source=$($sourceFiles.Count), backup=$($backupFiles.Count)"
    }

    $sourceDirs = @(Get-ChildItem -LiteralPath $sourceRuntime -Directory -Recurse -Force | ForEach-Object {
        [System.IO.Path]::GetRelativePath($sourceRuntime, $_.FullName)
    } | Sort-Object)
    $backupDirs = @(Get-ChildItem -LiteralPath $backupRuntime -Directory -Recurse -Force | ForEach-Object {
        [System.IO.Path]::GetRelativePath($backupRuntime, $_.FullName)
    } | Sort-Object)
    if (($sourceDirs -join "`n") -ne ($backupDirs -join "`n")) {
        throw 'Directory layout mismatch between source and backup.'
    }

    $manifest = New-Object System.Collections.Generic.List[string]
    $manifest.Add("# relative_path`tbytes`tsha256")
    $totalBytes = [long]0
    foreach ($sourceFile in $sourceFiles) {
        $relative = [System.IO.Path]::GetRelativePath($sourceRuntime, $sourceFile.FullName)
        $targetFile = Join-Path $backupRuntime $relative
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) {
            throw "Backup file is missing: $relative"
        }
        $targetInfo = Get-Item -LiteralPath $targetFile
        if ($sourceFile.Length -ne $targetInfo.Length) {
            throw "File size mismatch: $relative"
        }
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) {
            throw "SHA-256 mismatch: $relative"
        }
        $totalBytes += $sourceFile.Length
        $manifest.Add("$relative`t$($sourceFile.Length)`t$sourceHash")
    }

    $manifestPath = Join-Path $backupSet 'sha256-manifest.tsv'
    [System.IO.File]::WriteAllLines($manifestPath, $manifest, $script:Utf8NoBom)
    $summary = @{
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        source = $sourceRuntime
        backup = $backupRuntime
        file_count = $sourceFiles.Count
        directory_count = $sourceDirs.Count + 1
        total_bytes = $totalBytes
        sha256_manifest = $manifestPath
        verified = $true
    } | ConvertTo-Json -Depth 3
    Write-Utf8File (Join-Path $backupSet 'backup-summary.json') $summary
    Write-Ok "Runtime backup verified: $backupRuntime"
    Write-Ok "Files=$($sourceFiles.Count), bytes=$totalBytes, manifest=$manifestPath"
} catch {
    try { Write-Utf8File (Join-Path $backupSet 'BACKUP-INVALID.txt') $_.Exception.Message } catch { }
    Write-Warn "Runtime backup verification failed. Services remain stopped. Incomplete backup: $backupSet"
    throw
}

if ($Restart) {
    Write-Info 'Restarting services after successful backup verification'
    & (Join-Path $PSScriptRoot 'start-all.ps1')
    if ($LASTEXITCODE -ne 0) { throw "start-all.ps1 failed with exit code $LASTEXITCODE" }
}
