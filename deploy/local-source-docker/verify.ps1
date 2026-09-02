# 检查本地整体镜像和容器状态，不启动服务。

param([switch]$SkipLlm)

$ErrorActionPreference = 'Stop'
$deployDir = $PSScriptRoot
$localEnvPath = Join-Path $deployDir '.env'
. (Join-Path $deployDir '_lib.ps1')
Import-DotEnv $localEnvPath

$image = Get-EnvValue 'MEMORY_STACK_IMAGE' 'tdai-local/memory-stack:local'
$result = Invoke-DockerText @('image', 'inspect', $image) -AllowFailure
if ($script:LastDockerExitCode -eq 0) { Write-Ok "整体镜像本地已存在：$image" }
else { Write-Warn "整体镜像本地不存在：$image" }

if (Test-ContainerRunning 'tdai-memory-stack') {
    $health = Invoke-DockerText @('inspect', '-f', '{{.State.Health.Status}}', 'tdai-memory-stack') -AllowFailure
    Write-Ok "tdai-memory-stack 正在运行（$($health.Trim())）"
} else {
    Test-StartupPorts
}
if ($SkipLlm) { Write-Info '跳过 LLM 通路检查（-SkipLlm）' }
