# 停止本地整体容器；默认保留数据卷。

param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$deployDir = $PSScriptRoot
$localEnvPath = Join-Path $deployDir '.env'
. (Join-Path $deployDir '_lib.ps1')
Import-DotEnv $localEnvPath
if (Test-ContainerExists 'tdai-memory-stack') {
    Write-Info '停止并移除 tdai-memory-stack'
    Invoke-DockerText @('rm', '-f', 'tdai-memory-stack') | Out-Null
}
if ($Purge) {
    foreach ($volumeName in @(
        (Get-EnvValue 'MEMORY_CORE_VOLUME' 'tdai-local-memory-core-data'),
        (Get-EnvValue 'PANEL_VOLUME' 'tdai-local-panel-data'),
        (Get-EnvValue 'PROXY_VOLUME' 'tdai-local-proxy-data')
    )) {
        Invoke-DockerText @('volume', 'inspect', $volumeName) -AllowFailure | Out-Null
        if ($script:LastDockerExitCode -eq 0) {
            Invoke-DockerText @('volume', 'rm', $volumeName) | Out-Null
            Write-Ok "已删除 volume $volumeName"
        }
    }

    $configuredPaths = @(
        (Get-EnvValue 'MEMORY_CORE_CONFIG_DIR' '.memory-core-config'),
        (Get-EnvValue 'PROXY_CONFIG_DIR' '.proxy-config'),
        (Get-EnvValue 'MEMORY_CORE_ADMIN_KEY_FILE' '.admin-key')
    )
    foreach ($configuredPath in $configuredPaths) {
        $target = if ([System.IO.Path]::IsPathRooted($configuredPath)) {
            $configuredPath
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $deployDir $configuredPath))
        }
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
            Write-Ok "已删除 $target"
        }
    }
}
