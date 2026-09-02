param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

$coreDir = Join-Path $script:RepoRoot 'MemoryCore'
$knowledgeDir = Join-Path $script:RepoRoot 'MemoryKnowledge'
$panelDir = Join-Path $script:RepoRoot 'MemoryPanel'
$panelWebDir = Join-Path $panelDir 'web'
$proxyDir = Join-Path $script:RepoRoot 'MemoryProxy'

if (-not $SkipInstall) {
    Write-Info 'Installing MemoryCore dependencies'
    Invoke-ProjectCommand $coreDir 'npm.cmd' @('install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund')
    Invoke-ProjectCommand $coreDir 'npm.cmd' @('rebuild', 'esbuild')

    Write-Info 'Installing MemoryKnowledge dependencies'
    Invoke-ProjectCommand $knowledgeDir 'pnpm.cmd' @('install', '--ignore-workspace')

    Write-Info 'Installing MemoryPanel dependencies'
    Invoke-ProjectCommand $panelDir 'pnpm.cmd' @('install', '--frozen-lockfile')
    Invoke-ProjectCommand $panelWebDir 'npm.cmd' @('ci', '--no-audit', '--no-fund')

    Write-Info 'Installing MemoryProxy dependencies'
    Invoke-ProjectCommand $proxyDir 'npm.cmd' @('ci', '--no-audit', '--no-fund')
}

Write-Info 'Building MemoryCore'
Invoke-ProjectCommand $coreDir 'npm.cmd' @('run', 'build:plugin')

Write-Info 'Building MemoryKnowledge'
Invoke-ProjectCommand $knowledgeDir 'pnpm.cmd' @('run', 'build')

Write-Info 'Building MemoryPanel backend'
Invoke-ProjectCommand $panelDir 'pnpm.cmd' @('run', 'build')

Write-Info 'Building MemoryPanel web'
Invoke-ProjectCommand $panelWebDir 'npm.cmd' @('run', 'build')

Write-Ok 'Source dependencies and build artifacts are ready'
