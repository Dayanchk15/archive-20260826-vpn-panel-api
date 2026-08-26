param(
  [int]$Limit = 5000,
  [int]$Concurrency = 20,
  [int]$TimeoutMs = 7000,
  [string]$LocalAddress = ""
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
Set-Location $repo
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $repo "tmp\ip-scans\bunny\$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$args = @(
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $repo 'scripts\run-tm-bunny-ip-scan.ps1'),
  '-Limit', $Limit,
  '-Concurrency', $Concurrency,
  '-TimeoutMs', $TimeoutMs,
  '-BunnyHost', 'levospeed.it.com',
  '-BunnyPath', '/health',
  '-BunnyApplicationLimit', 300,
  '-Out', (Join-Path $outDir 'report.json'),
  '-FoundOut', (Join-Path $outDir 'working.json'),
  '-FoundIpsOut', (Join-Path $outDir 'working.txt')
)
if ($LocalAddress) { $args += @('-LocalAddress', $LocalAddress) }

Write-Host "Bunny/TM scan started. Results: $outDir"
powershell @args
if ($LASTEXITCODE -ne 0) { throw "Bunny scan failed with exit code $LASTEXITCODE" }
Write-Host "Working IPs: $(Join-Path $outDir 'working.txt')"
