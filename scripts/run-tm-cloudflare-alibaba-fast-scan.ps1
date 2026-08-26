param(
  [ValidateSet('all','cloudflare','alibaba')]
  [string]$Provider = 'all',
  [string]$InterfaceAlias = '',
  [int]$CloudflareLimit = 1600,
  [int]$AlibabaLimit = 6000,
  [int]$Concurrency = 40,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,1000)]
  [int]$ProgressEvery = 25,
  [ValidateRange(1,5)]
  [int]$Passes = 3,
  [int]$Top = 100,
  [switch]$PrepareOnly,
  [string]$CloudflareCandidateFile = '',
  [string]$AlibabaCandidateFile = '',
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$utf8 = [Text.UTF8Encoding]::new($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $repo "tmp\tm-cloudflare-alibaba-$stamp"
}
$candidateRoot = Join-Path $OutputRoot 'candidates'
$candidateCurrent = $candidateRoot
$resultsRoot = Join-Path $OutputRoot 'results'
New-Item -ItemType Directory -Force -Path $OutputRoot,$candidateRoot,$resultsRoot | Out-Null

$skipLiveRefresh =
  ($Provider -eq 'cloudflare' -and [bool]$CloudflareCandidateFile) -or
  ($Provider -eq 'alibaba' -and [bool]$AlibabaCandidateFile)

if ($skipLiveRefresh) {
  Write-Host '=== Using the supplied candidate list (live refresh skipped) ==='
  $refreshExitCode = 0
} else {
Write-Host '=== Preparing current Cloudflare + Alibaba candidates ==='
$proxyNames = @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY')
$proxyBackup = @{}
foreach ($name in $proxyNames) {
  $proxyBackup[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$env:NODE_USE_ENV_PROXY = '0'
try {
  node (Join-Path $PSScriptRoot 'build-cloudflare-alibaba-candidates.mjs') `
    --out=$candidateRoot `
    --cloudflare-limit=$CloudflareLimit `
    --alibaba-limit=$AlibabaLimit
  $refreshExitCode = $LASTEXITCODE
} finally {
  foreach ($name in $proxyNames) {
    [Environment]::SetEnvironmentVariable($name, $proxyBackup[$name], 'Process')
  }
}

if ($refreshExitCode -ne 0) {
  Write-Warning 'Live candidate refresh is unavailable on the current network. Using the bundled lists prepared on 2026-08-12.'
  $fallbacks = @{
    'cloudflare-candidates.txt' = Join-Path $repo 'ops\ip-lists\cloudflare-current-candidates.txt'
    'cloudflare-prefixes.txt' = Join-Path $repo 'ops\ip-lists\cloudflare-current-prefixes.txt'
    'alibaba-candidates.txt' = Join-Path $repo 'ops\ip-lists\alibaba-current-candidates.txt'
    'alibaba-prefixes.txt' = Join-Path $repo 'ops\ip-lists\alibaba-current-prefixes.txt'
  }
  foreach ($entry in $fallbacks.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value)) {
      throw "Live refresh failed and fallback file is missing: $($entry.Value)"
    }
    Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $candidateRoot $entry.Key) -Force
  }
}
}

$candidateOverrides = @{
  cloudflare = $CloudflareCandidateFile
  alibaba = $AlibabaCandidateFile
}
foreach ($entry in $candidateOverrides.GetEnumerator()) {
  if (-not $entry.Value) { continue }
  $resolvedOverride = Resolve-Path -LiteralPath $entry.Value -ErrorAction Stop
  $overrideIps = @(Get-Content -LiteralPath $resolvedOverride |
    ForEach-Object { if ($_ -match '^\s*((?:\d{1,3}\.){3}\d{1,3})\s*$') { $Matches[1] } } |
    Select-Object -Unique)
  if (-not $overrideIps.Count) { throw "No IPv4 candidates in override file: $resolvedOverride" }
  [IO.File]::WriteAllLines((Join-Path $candidateRoot "$($entry.Key)-candidates.txt"), $overrideIps, $utf8)
  Write-Host "$($entry.Key) override candidates: $($overrideIps.Count) from $resolvedOverride"
}

if ($PrepareOnly) {
  Write-Host ''
  Write-Host 'Candidate preparation completed; no network scan was started.'
  Write-Host "Cloudflare: $(Join-Path $candidateCurrent 'cloudflare-candidates.txt')"
  Write-Host "Alibaba:   $(Join-Path $candidateCurrent 'alibaba-candidates.txt')"
  Write-Host "Run root:  $OutputRoot"
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator. The scan adds temporary routes through the TM modem and removes them after each pass.'
}

$providers = if ($Provider -eq 'all') { @('cloudflare','alibaba') } else { @($Provider) }
$activeCandidates = @{
  cloudflare = Join-Path $candidateCurrent 'cloudflare-candidates.txt'
  alibaba = Join-Path $candidateCurrent 'alibaba-candidates.txt'
}
$disabledProviders = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

for ($pass = 1; $pass -le $Passes; $pass += 1) {
  Write-Host ''
  Write-Host "=== Validation pass $pass/$Passes ==="
  foreach ($name in $providers) {
    if ($disabledProviders.Contains($name)) {
      Write-Host "$name skipped on pass $pass because the previous pass found no qualified IPs."
      continue
    }
    $passCandidates = Join-Path $OutputRoot "pass-$pass-$name-candidates"
    New-Item -ItemType Directory -Force -Path $passCandidates | Out-Null
    Copy-Item -LiteralPath $activeCandidates[$name] -Destination (Join-Path $passCandidates "$name-candidates.txt") -Force

    $passOutput = Join-Path $resultsRoot "pass-$pass-$name"
    $limit = if ($name -eq 'cloudflare') { $CloudflareLimit } else { $AlibabaLimit }
    $arguments = @{
      Provider = $name
      CandidateDirectory = $passCandidates
      OutputRoot = $passOutput
      LimitPerProvider = $limit
      Concurrency = $Concurrency
      TimeoutMs = $TimeoutMs
      ProgressEvery = $ProgressEvery
      Top = $Top
      InterfaceAlias = $InterfaceAlias
    }
    if ($name -eq 'cloudflare') {
      $arguments.CloudflareHost = 'fr1.levospeed.online'
      $arguments.CloudflarePath = '/'
    } else {
      $arguments.AlibabaMode = 'ws'
      $arguments.AlibabaSni = 'www.alibaba.com'
      $arguments.AlibabaHost = 'cdn-a1.levospeed.click'
      $arguments.AlibabaPath = '/'
    }

    & (Join-Path $PSScriptRoot 'test-cdn-backups-from-tm.ps1') @arguments
    if ($LASTEXITCODE -ne 0) { throw "$name pass $pass failed." }

    $working = Join-Path $passOutput "current-working\$name-working.txt"
    if (-not (Test-Path -LiteralPath $working)) { throw "$name pass $pass did not create a working-IP file." }
    $workingIps = @(Get-Content -LiteralPath $working | Where-Object { $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' } | Select-Object -Unique)
    Write-Host "$name pass $pass qualified: $($workingIps.Count)"
    if (-not $workingIps.Count) {
      Write-Warning "$name has no fully qualified IPs. Later passes for this provider are skipped."
      [void]$disabledProviders.Add($name)
      continue
    }
    $activeCandidates[$name] = $working
  }
}

function Get-Median([double[]]$Values) {
  $sorted = @($Values | Sort-Object)
  if (-not $sorted.Count) { return $null }
  $middle = [math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2) { return [math]::Round($sorted[$middle], 1) }
  return [math]::Round(($sorted[$middle - 1] + $sorted[$middle]) / 2, 1)
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  modemBoundScan = $true
  passesRequested = $Passes
  providers = [ordered]@{}
}

foreach ($name in $providers) {
  $reports = @(Get-ChildItem -LiteralPath $resultsRoot -Recurse -Filter "$name-report.json" -File | Sort-Object FullName)
  $byIp = @{}
  foreach ($reportFile in $reports) {
    $doc = Get-Content -LiteralPath $reportFile.FullName -Raw | ConvertFrom-Json
    $rows = @($doc.$name.rows | Where-Object { $_.ok -eq $true })
    foreach ($row in $rows) {
      $ip = [string]$row.ip
      if (-not $byIp.ContainsKey($ip)) { $byIp[$ip] = [Collections.Generic.List[object]]::new() }
      $applicationMs = if ($null -ne $row.wsMs) { [double]$row.wsMs } elseif ($null -ne $row.httpMs) { [double]$row.httpMs } else { 0 }
      $byIp[$ip].Add([pscustomobject]@{
        tcpMs = [double]$row.tcpMs
        tlsMs = [double]$row.tlsMs
        appMs = $applicationMs
        totalMs = [double]$row.tcpMs + [double]$row.tlsMs + $applicationMs
      })
    }
  }

  $ranked = @()
  foreach ($entry in $byIp.GetEnumerator()) {
    $samples = @($entry.Value)
    $ranked += [pscustomobject]@{
      ip = $entry.Key
      successfulPasses = $samples.Count
      medianTcpMs = Get-Median @($samples.tcpMs)
      medianTlsMs = Get-Median @($samples.tlsMs)
      medianAppMs = Get-Median @($samples.appMs)
      medianTotalMs = Get-Median @($samples.totalMs)
    }
  }
  $ranked = @($ranked | Sort-Object @{Expression='successfulPasses';Descending=$true}, @{Expression='medianTotalMs';Descending=$false})
  $stable = @($ranked | Where-Object { $_.successfulPasses -eq $reports.Count })
  $final = if ($stable.Count) { $stable } else { $ranked }
  $txt = Join-Path $OutputRoot "$name-fast-stable.txt"
  $json = Join-Path $OutputRoot "$name-fast-ranking.json"
  [IO.File]::WriteAllLines($txt, @($final | Select-Object -First $Top -ExpandProperty ip), $utf8)
  [IO.File]::WriteAllText($json, ($ranked | ConvertTo-Json -Depth 5), $utf8)
  $summary.providers[$name] = [ordered]@{
    reports = $reports.Count
    uniqueQualified = $ranked.Count
    stableAcrossAllPasses = $stable.Count
    selectedCount = [math]::Min($Top, $final.Count)
    fastest = @($final | Select-Object -First 10)
    ipFile = $txt
    rankingFile = $json
  }
}

$summaryPath = Join-Path $OutputRoot 'summary.json'
[IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 8), $utf8)
Write-Host ''
Write-Host '=== Scan complete ==='
Write-Host "Summary: $summaryPath"
foreach ($name in $providers) {
  Write-Host "$name fastest stable IPs: $(Join-Path $OutputRoot "$name-fast-stable.txt")"
}
