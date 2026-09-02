# 从当前工作树直接构建一个整体运行镜像。

param(
    [string]$Tag = 'local',
    [string]$Namespace = 'tdai-local',
    [switch]$NoCache,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$deployDir = $PSScriptRoot
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $deployDir '..\..'))
$dockerfile = Join-Path $deployDir 'Dockerfile'
$image = "$Namespace/memory-stack:$Tag"

function Write-Info([string]$Message) {
    Write-Host "[build-local] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[build-local][ok] $Message" -ForegroundColor Green
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '找不到 docker。请先启动 Docker Desktop。'
}
foreach ($required in @($dockerfile, (Join-Path $deployDir 'start-unified.mjs'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "缺少构建文件：$required"
    }
}

$arguments = @(
    'build', '--progress=plain', '--pull=false',
    '-t', $image,
    '-f', $dockerfile
)
if ($NoCache) { $arguments += '--no-cache' }
if ($Offline) { $arguments += '--network=none' }
$arguments += $repoRoot

Write-Info "源码根目录：$repoRoot"
Write-Info "构建整体镜像：$image"
if ($Offline) { Write-Info '已关闭 Docker 构建网络；仅使用本机缓存。' }
else { Write-Info '仅在依赖缺失时下载；Docker 缓存会复用于后续构建。' }

& docker @arguments
if ($LASTEXITCODE -ne 0) {
    throw "docker build 失败：$image"
}

Write-Ok "整体镜像已生成：$image"
