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

# 判断指定的 node.exe 是否属于本工程要求的 Node.js 22。
function Test-Node22([string]$NodePath) {
    if (-not $NodePath) { return $false }
    $nodeExists = Test-Path -LiteralPath $NodePath -PathType Leaf
    if (-not $nodeExists) { return $false }

    try {
        $major = & $NodePath -p "process.versions.node.split('.')[0]" 2>$null
        $isNode22 = ($LASTEXITCODE -eq 0) -and ([string]$major -eq '22')
        return $isNode22
    } catch {
        return $false
    }
}

# 从 .runtime/tools 中选择版本最高且可运行的便携 Node.js 22。
function Find-PortableNode22 {
    $toolsDir = Join-Path $script:RuntimeDir 'tools'
    $toolsDirExists = Test-Path -LiteralPath $toolsDir -PathType Container
    if (-not $toolsDirExists) { return $null }

    $directories = Get-ChildItem -LiteralPath $toolsDir -Directory -Filter 'node-v22.*-win-x64'
    $candidates = foreach ($directory in $directories) {
        if ($directory.Name -notmatch '^node-v(?<Version>22\.[0-9]+\.[0-9]+)-win-x64$') { continue }
        $nodePath = Join-Path $directory.FullName 'node.exe'
        $nodeIsVersion22 = Test-Node22 $nodePath
        if ($nodeIsVersion22) {
            [pscustomobject]@{ Version = [version]$Matches.Version; NodePath = $nodePath }
        }
    }

    $selected = $candidates | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -eq $selected) { return $null }
    return $selected.NodePath
}

# 从 Node.js 官网下载 Windows x64 ZIP，并使用官网清单校验 SHA-256。
function Install-PortableNode22 {
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'The automatic Node.js 22 download currently supports Windows x64 only.'
    }

    $downloadsDir = Join-Path $script:RuntimeDir 'downloads'
    $toolsDir = Join-Path $script:RuntimeDir 'tools'
    New-Item -ItemType Directory -Path $downloadsDir, $toolsDir -Force | Out-Null

    $baseUrl = 'https://nodejs.org/dist/latest-v22.x'
    Write-Info 'Current Node.js is not v22; reading the official Node.js 22 release manifest'
    $checksums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 120).Content
    $match = [regex]::Match($checksums, '(?m)^([0-9a-f]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\r?$')
    if (-not $match.Success) {
        throw 'The official manifest does not contain a Node.js 22 Windows x64 ZIP.'
    }

    $expectedHash = $match.Groups[1].Value.ToUpperInvariant()
    $fileName = $match.Groups[2].Value
    $archivePath = Join-Path $downloadsDir $fileName
    $archiveReady = $false
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $archiveReady = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -eq $expectedHash
    }

    if (-not $archiveReady) {
        Write-Info "Downloading $fileName from nodejs.org"
        Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $archivePath -UseBasicParsing -TimeoutSec 600
    }

    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 verification failed for $fileName"
    }

    $nodeDir = Join-Path $toolsDir ([System.IO.Path]::GetFileNameWithoutExtension($fileName))
    $nodePath = Join-Path $nodeDir 'node.exe'
    $nodeIsReady = Test-Node22 $nodePath
    if (-not $nodeIsReady) {
        Write-Info "Extracting $fileName"
        Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDir -Force
    }
    $nodeIsReady = Test-Node22 $nodePath
    if (-not $nodeIsReady) {
        throw "The downloaded Node.js executable is invalid: $nodePath"
    }

    Write-Ok "Portable Node.js installed: $nodePath"
    return $nodePath
}

# 仅修改当前 PowerShell 进程及其子进程的 PATH，不影响系统 Node.js。
function Use-Node22 {
    $current = Get-Command node.exe -ErrorAction SilentlyContinue
    $currentIsNode22 = $false
    if ($current) {
        $currentIsNode22 = Test-Node22 $current.Source
    }
    if ($currentIsNode22) {
        Write-Info "Using Node.js $(& $current.Source --version): $($current.Source)"
        return $current.Source
    }

    $nodePath = Find-PortableNode22
    if (-not $nodePath) {
        $nodePath = Install-PortableNode22
    }

    $nodeDir = Split-Path -Parent $nodePath
    $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
    [Environment]::SetEnvironmentVariable('Path', "$nodeDir;$processPath", 'Process')
    Write-Info "Using Node.js $(& $nodePath --version): $nodePath"
    return $nodePath
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
