$ErrorActionPreference = 'Stop'

$script:DeployDir = $PSScriptRoot
$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $script:DeployDir '..\..'))
$script:RuntimeDir = Join-Path $script:DeployDir '.runtime'
$script:ConfigDir = Join-Path $script:RuntimeDir 'config'
$script:DataDir = Join-Path $script:RuntimeDir 'data'
$script:LogDir = Join-Path $script:RuntimeDir 'logs'
$script:ProcessDir = Join-Path $script:RuntimeDir 'processes'
$script:AdminKeyFile = Join-Path $script:DeployDir '.admin-key'
$script:EnvFile = Join-Path $script:DeployDir '.env'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:ServiceNames = @('memory-core', 'knowledge', 'panel', 'proxy')

$processPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $processPath, 'Process')

function Write-Info([string]$Message) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Initialize-RuntimeDirectories {
    foreach ($path in @(
        $script:RuntimeDir,
        $script:ConfigDir,
        $script:DataDir,
        $script:LogDir,
        $script:ProcessDir,
        (Join-Path $script:DataDir 'memory-core'),
        (Join-Path $script:DataDir 'knowledge'),
        (Join-Path $script:DataDir 'proxy')
    )) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Import-DotEnv {
    foreach ($line in Get-Content -LiteralPath $script:EnvFile -Encoding UTF8) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
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
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Get-EnvValue([string]$Name, [string]$Default = '') {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ($null -eq $value) { return $Default }
    return $value
}

function Write-Utf8File([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function ConvertTo-YamlScalar([string]$Value) {
    return ($Value | ConvertTo-Json -Compress)
}

function Invoke-ProjectCommand(
    [string]$WorkingDirectory,
    [string]$Command,
    [string[]]$Arguments
) {
    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Get-ProcessRecordPath([string]$Name) {
    return Join-Path $script:ProcessDir "$Name.json"
}

function Read-ProcessRecord([string]$Name) {
    $path = Get-ProcessRecordPath $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-TrackedProcess([string]$Name) {
    $record = Read-ProcessRecord $Name
    if ($null -eq $record) { return $null }

    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    if ($process.StartTime.ToUniversalTime().Ticks -ne [long]$record.startedUtcTicks) { return $null }
    return $process
}

function Start-SourceProcess(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$FilePath,
    [string[]]$Arguments,
    [hashtable]$Environment
) {
    $stdout = Join-Path $script:LogDir "$Name.stdout.log"
    $stderr = Join-Path $script:LogDir "$Name.stderr.log"
    $savedEnvironment = @{}

    foreach ($key in $Environment.Keys) {
        $savedEnvironment[$key] = @{
            Defined = Test-Path -LiteralPath "Env:$key"
            Value = [Environment]::GetEnvironmentVariable($key, 'Process')
        }
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }

    try {
        $process = Start-Process `
            -FilePath $FilePath `
            -ArgumentList ($Arguments -join ' ') `
            -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -WindowStyle Hidden `
            -PassThru
    } finally {
        foreach ($key in $savedEnvironment.Keys) {
            $saved = $savedEnvironment[$key]
            if ($saved.Defined) {
                [Environment]::SetEnvironmentVariable($key, [string]$saved.Value, 'Process')
            } else {
                [Environment]::SetEnvironmentVariable($key, $null, 'Process')
            }
        }
    }

    $record = @{
        pid = $process.Id
        startedUtcTicks = $process.StartTime.ToUniversalTime().Ticks
        stdout = $stdout
        stderr = $stderr
    } | ConvertTo-Json
    Write-Utf8File (Get-ProcessRecordPath $Name) $record
    return $process
}

function Wait-SourceService(
    [string]$Name,
    [System.Diagnostics.Process]$Process,
    [string]$HealthUrl,
    [int]$TimeoutSeconds = 60
) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            $record = Read-ProcessRecord $Name
            if ($record -and (Test-Path -LiteralPath $record.stderr)) {
                Get-Content -LiteralPath $record.stderr -Tail 20
            }
            throw "$Name exited with code $($Process.ExitCode)"
        }

        try {
            $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
            if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
                Write-Ok "$name is ready"
                return
            }
        } catch {
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name was not ready in ${TimeoutSeconds}s. Log: $(Join-Path $script:LogDir "$Name.stderr.log")"
}

function Stop-TrackedProcesses([switch]$Quiet) {
    $names = @($script:ServiceNames)
    [array]::Reverse($names)

    foreach ($name in $names) {
        $recordPath = Get-ProcessRecordPath $name
        $record = Read-ProcessRecord $name
        if ($null -eq $record) { continue }

        $process = Get-TrackedProcess $name
        if ($process) {
            Stop-Process -Id $process.Id
            $deadline = (Get-Date).AddSeconds(5)
            while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 100
                $process.Refresh()
            }
            if (-not $Quiet) { Write-Ok "$name stopped" }
        } elseif (-not $Quiet) {
            Write-Warn "$name has a stale process record"
        }
        Remove-Item -LiteralPath $recordPath -Force
    }
}

function New-RandomUserKey {
    $bytes = New-Object byte[] 24
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    $token = [Convert]::ToBase64String($bytes).Replace('+', '').Replace('/', '').Replace('=', '')
    return "sk-mem-$token"
}

function Invoke-JsonRequest(
    [string]$Uri,
    [string]$Method,
    [hashtable]$Headers,
    [hashtable]$Body
) {
    try {
        $response = Invoke-WebRequest `
            -Uri $Uri `
            -Method $Method `
            -Headers $Headers `
            -ContentType 'application/json' `
            -Body ($Body | ConvertTo-Json -Compress) `
            -UseBasicParsing `
            -TimeoutSec 30
        return @{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
    } catch {
        $response = $_.Exception.Response
        if ($null -eq $response) { throw }
        if ($response.GetType().FullName -eq 'System.Net.Http.HttpResponseMessage') {
            try {
                $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            } catch {
                $content = ''
            }
            return @{ Status = [int]$response.StatusCode; Body = [string]$content }
        }
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            return @{ Status = [int]$response.StatusCode; Body = $reader.ReadToEnd() }
        } finally {
            $reader.Dispose()
        }
    }
}

function Write-ServiceEndpoints {
    Write-Host ''
    Write-Host "Panel UI       http://127.0.0.1:$(Get-EnvValue 'PANEL_PORT' '8125')/"
    Write-Host "Knowledge API  http://127.0.0.1:$(Get-EnvValue 'KNOWLEDGE_PORT' '8424')/v3/"
    Write-Host "Knowledge Docs http://127.0.0.1:$(Get-EnvValue 'KNOWLEDGE_PORT' '8424')/docs"
    Write-Host "Memory Core    http://127.0.0.1:$(Get-EnvValue 'MEMORY_CORE_PORT' '8420')/"
    Write-Host "Proxy          http://127.0.0.1:$(Get-EnvValue 'PROXY_PORT' '8096')/"
}
