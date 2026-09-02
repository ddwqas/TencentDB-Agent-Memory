# 本地源码 Docker PowerShell 公共函数。

$ErrorActionPreference = 'Stop'

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$script:Docker = if ($dockerCommand) {
    if ($dockerCommand.Source) { $dockerCommand.Source } else { $dockerCommand.Name }
} else {
    $null
}
if (-not $script:Docker) { throw '找不到 docker。请先启动 Docker Desktop。' }

function Write-Info([string]$Message) {
    Write-Host "[local-docker] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[local-docker][ok] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "[local-docker][warn] $Message" -ForegroundColor Yellow
}

function Get-EnvValue([string]$Name, [string]$Default = '') {
    if ($script:DotEnv.ContainsKey($Name)) { return [string]$script:DotEnv[$Name] }
    $item = Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $Default }
    return [string]$item.Value
}

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw ".env 不存在：$Path" }

    $script:DotEnv = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text.StartsWith('export ')) { $text = $text.Substring(7).Trim() }
        if ($text -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }

        $name = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        if ($value -notmatch '^"' -and $value -notmatch "^'") {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }
        $script:DotEnv[$name] = $value
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Invoke-DockerText([string[]]$Arguments, [switch]$AllowFailure) {
    $output = @(& $script:Docker @Arguments 2>&1)
    $script:LastDockerExitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $script:LastDockerExitCode -ne 0) {
        $details = ($output | Out-String).Trim()
        if ($details) { throw "docker $($Arguments -join ' ') 失败（退出码 $script:LastDockerExitCode）：$details" }
        throw "docker $($Arguments -join ' ') 失败（退出码 $script:LastDockerExitCode）"
    }
    return (($output | ForEach-Object { [string]$_ }) -join "`n")
}

function Test-ContainerExists([string]$Name) {
    $names = Invoke-DockerText @('ps', '-a', '--format', '{{.Names}}') -AllowFailure
    return ($names -split "`r?`n" | Where-Object { $_ -eq $Name }).Count -gt 0
}

function Test-ContainerRunning([string]$Name) {
    $names = Invoke-DockerText @('ps', '--format', '{{.Names}}') -AllowFailure
    return ($names -split "`r?`n" | Where-Object { $_ -eq $Name }).Count -gt 0
}

function Wait-Healthy([string]$Name, [int]$TimeoutSeconds = 180) {
    Write-Info "等待 $Name 就绪（最长 ${TimeoutSeconds}s）..."
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $status = Invoke-DockerText @('inspect', '-f', '{{.State.Status}}', $Name) -AllowFailure
        if ($script:LastDockerExitCode -ne 0) { $status = 'missing' }
        $health = Invoke-DockerText @('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', $Name) -AllowFailure
        if ($script:LastDockerExitCode -ne 0) { $health = 'unknown' }

        if ($status.Trim() -ne 'running') {
            Invoke-DockerText @('logs', '--tail', '30', $Name) -AllowFailure | Write-Host
            throw "$Name 未运行。"
        }
        switch ($health.Trim()) {
            'healthy' { Write-Ok "$Name healthy"; return }
            'unhealthy' {
                Invoke-DockerText @('logs', '--tail', '30', $Name) -AllowFailure | Write-Host
                throw "$Name 健康检查失败。"
            }
            'none' { Write-Ok "$Name running（无 healthcheck）"; return }
        }
        Start-Sleep -Seconds 2
    }
    Invoke-DockerText @('logs', '--tail', '30', $Name) -AllowFailure | Write-Host
    throw "$Name 在 ${TimeoutSeconds}s 内未就绪。"
}

function Test-StartupPorts {
    foreach ($name in @('MEMORY_CORE_PORT', 'PANEL_PORT', 'KNOWLEDGE_PORT', 'PROXY_PORT')) {
        $value = Get-EnvValue $name
        if (-not $value) { continue }
        $connection = Get-NetTCPConnection -State Listen -LocalPort ([int]$value) -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($connection) { Write-Warn "端口 $value ($name) 已被占用" }
        else { Write-Ok "端口 $value ($name) 空闲" }
    }
}

$script:DotEnv = @{}
