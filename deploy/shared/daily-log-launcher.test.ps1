$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\local-source-windows\_lib.ps1')
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('daily-launcher-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:LogDir = Join-Path $testRoot 'logs'
$script:ProcessDir = Join-Path $testRoot 'processes'
New-Item -ItemType Directory -Path $script:LogDir,$script:ProcessDir | Out-Null
$entry = Join-Path $testRoot 'entry.cjs'
Set-Content -LiteralPath $entry -Encoding utf8 -Value 'console.log("launcher stdout"); console.error("launcher stderr"); setTimeout(() => {}, 500);'
try {
    $nodePath = (Get-Command node).Source
    for ($i = 0; $i -lt 2; $i++) {
        $child = Start-SourceProcess 'daily-launcher-test' $testRoot $nodePath @(('"' + $entry + '"')) @{}
        if (-not $child.WaitForExit(5000)) { throw 'Test process did not exit' }
        if ($child.ExitCode -ne 0) { throw "Test process failed: $($child.ExitCode)" }
    }
    foreach ($stream in @('stdout','stderr')) {
        $file = Get-ServiceLogPath 'daily-launcher-test' $stream
        $lines = @(Get-Content -LiteralPath $file)
        if ($lines.Count -ne 2) { throw "Expected two appended $stream lines, got $($lines.Count)" }
    }
    Write-Output 'PASS: Windows launcher preserves stdout/stderr across same-day restarts.'
} finally {
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id }
    $resolved = [System.IO.Path]::GetFullPath($testRoot)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $resolved.Contains('daily-launcher-test-')) { throw 'Unsafe test cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
