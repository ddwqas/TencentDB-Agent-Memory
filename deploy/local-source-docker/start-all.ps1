# 启动整体镜像：Core、Panel、Knowledge、Proxy 共用一个容器。

param([switch]$NonInteractive)

$ErrorActionPreference = 'Stop'
$deployDir = $PSScriptRoot
$localEnvPath = Join-Path $deployDir '.env'
$container = 'tdai-memory-stack'

if (-not (Test-Path -LiteralPath $localEnvPath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $deployDir '.env.example') -Destination $localEnvPath
    Write-Host "已创建 $localEnvPath，请填写 LLM 配置后重新执行。" -ForegroundColor Yellow
    exit 1
}

. (Join-Path $deployDir '_lib.ps1')
Import-DotEnv $localEnvPath

$image = Get-EnvValue 'MEMORY_STACK_IMAGE' 'tdai-local/memory-stack:local'
$corePort = Get-EnvValue 'MEMORY_CORE_PORT' '8420'
$panelPort = Get-EnvValue 'PANEL_PORT' '8125'
$knowledgePort = Get-EnvValue 'KNOWLEDGE_PORT' '8424'
$proxyPort = Get-EnvValue 'PROXY_PORT' '8096'
$coreVolume = Get-EnvValue 'MEMORY_CORE_VOLUME' 'tdai-local-memory-core-data'
$panelVolume = Get-EnvValue 'PANEL_VOLUME' 'tdai-local-panel-data'
$proxyVolume = Get-EnvValue 'PROXY_VOLUME' 'tdai-local-proxy-data'
$gatewayKey = Get-EnvValue 'MEMORY_CORE_GATEWAY_API_KEY'

$configuredKeyFile = Get-EnvValue 'MEMORY_CORE_ADMIN_KEY_FILE'
$keyFile = if ($configuredKeyFile) {
    if ([System.IO.Path]::IsPathRooted($configuredKeyFile)) { $configuredKeyFile }
    else { [System.IO.Path]::GetFullPath((Join-Path $deployDir $configuredKeyFile)) }
} else {
    Join-Path $deployDir '.admin-key'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $keyFile) -Force | Out-Null
if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    New-Item -ItemType File -Path $keyFile -Force | Out-Null
}

if (Test-ContainerExists $container) {
    Write-Info "移除已存在的容器 $container"
    Invoke-DockerText @('rm', '-f', $container) | Out-Null
}
foreach ($oldContainer in @('tdai-memory-core', 'tdai-memory-hub', 'tdai-proxy')) {
    if (Test-ContainerExists $oldContainer) {
        Write-Info "移除旧容器 $oldContainer"
        Invoke-DockerText @('rm', '-f', $oldContainer) | Out-Null
    }
}

$runArgs = @(
    'run', '-d', '--name', $container, '--restart', 'unless-stopped',
    '-p', "${corePort}:8420", '-p', "${panelPort}:8125",
    '-p', "${knowledgePort}:8424", '-p', "${proxyPort}:8096",
    '--mount', "type=volume,source=$coreVolume,target=/data/tdai-memory",
    '--mount', "type=volume,source=$panelVolume,target=/data/knowledge",
    '--mount', "type=volume,source=$proxyVolume,target=/data/tdai-memory-proxy",
    '--mount', "type=bind,source=$keyFile,target=/data/admin-key",
    '--env-file', $localEnvPath,
    '-e', 'MEMORY_CORE_ADMIN_KEY_FILE=/data/admin-key',
    '-e', "TDAI_GATEWAY_API_KEY=$gatewayKey",
    $image
)
Write-Info "启动整体镜像 (image=$image)"
Invoke-DockerText $runArgs | Out-Null
Wait-Healthy $container 180

Write-Ok '整体镜像已启动'
Write-Host "  Panel UI       http://localhost:$panelPort/"
Write-Host "  Panel API      http://localhost:$panelPort/api/v1/"
Write-Host "  Knowledge API  http://localhost:$knowledgePort/v3/"
Write-Host "  Memory Core    http://localhost:$corePort/"
Write-Host "  Proxy          http://localhost:$proxyPort/"
