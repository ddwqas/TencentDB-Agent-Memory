param([switch]$Purge)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

Stop-TrackedProcesses

if ($Purge) {
    if (Test-Path -LiteralPath $script:RuntimeDir) {
        Remove-Item -LiteralPath $script:RuntimeDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $script:AdminKeyFile) {
        Remove-Item -LiteralPath $script:AdminKeyFile -Force
    }
    Write-Ok 'Runtime data, logs, and the admin user key were removed'
}
