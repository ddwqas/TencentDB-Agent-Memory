$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

if (Test-Path -LiteralPath $script:EnvFile -PathType Leaf) {
    Import-DotEnv
}

$ports = @{
    'memory-core' = Get-EnvValue 'MEMORY_CORE_PORT' '8420'
    'knowledge' = Get-EnvValue 'KNOWLEDGE_PORT' '8424'
    'panel' = Get-EnvValue 'PANEL_PORT' '8125'
    'proxy' = Get-EnvValue 'PROXY_PORT' '8096'
}

$rows = foreach ($name in $script:ServiceNames) {
    $process = Get-TrackedProcess $name
    [pscustomobject]@{
        Service = $name
        Status = if ($process) { 'running' } else { 'stopped' }
        PID = if ($process) { $process.Id } else { $null }
        Port = $ports[$name]
    }
}
$rows | Format-Table -AutoSize

