param(
  [ValidateSet('all','cloudflare','tencent','alibaba')]
  [string]$Provider = 'all',
  [string]$CandidateDirectory = 'C:\Users\Admin\Desktop\cdn-ip-scans\reserve-cdn\current',
  [string]$OutputRoot = 'C:\Users\Admin\Desktop\cdn-ip-scans\reserve-cdn\tm-results',
  [string]$InterfaceAlias = '',
  [int]$LimitPerProvider = 2000,
  [int]$Concurrency = 12,
  [int]$TimeoutMs = 6500,
  [ValidateRange(1,1000)]
  [int]$ProgressEvery = 25,
  [int]$Top = 100,
  [string]$CloudflareHost = 'fr1.levospeed.online',
  [string]$CloudflarePath = '/',
  [string]$TencentSni = 'www.tencentwm.com',
  [string]$TencentHost = 'daykoo-tencent-fr1.levospeed.click',
  [string]$TencentPath = '/eo/v1/4bfa6f260da5',
  [ValidateSet('ws','xhttp')]
  [string]$AlibabaMode = 'ws',
  [string]$AlibabaSni = 'www.alibaba.com',
  [string]$AlibabaHost = 'cdn-a1.levospeed.click',
  [string]$AlibabaPath = '/'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $PSScriptRoot 'tm-cdn-ip-scan.mjs'
$utf8 = [Text.UTF8Encoding]::new($false)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator. Temporary routes are required to guarantee that probes use the TM modem.'
}
if (-not (Test-Path -LiteralPath $scanner)) { throw "Scanner not found: $scanner" }
if (-not (Test-Path -LiteralPath $CandidateDirectory)) {
  throw "Candidate directory not found: $CandidateDirectory. Run update-cdn-backup-candidates.ps1 first."
}

if ($InterfaceAlias) {
  $modem = Get-NetIPConfiguration -InterfaceAlias $InterfaceAlias -ErrorAction Stop
} else {
  $modem = Get-NetIPConfiguration |
    Where-Object {
      $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway -and (
        $_.InterfaceAlias -match 'Mobile|USB|Android|RNDIS|iPhone|Ethernet 3' -or
        $_.InterfaceDescription -match 'Apple Mobile|Remote NDIS|RNDIS|Mobile|USB|Android'
      )
    } |
    Select-Object -First 1

  # A TM modem/router is often connected as ordinary Wi-Fi or Ethernet and
  # therefore has no USB/RNDIS marker. Fall back to the active physical uplink
  # with a real IPv4 gateway, while excluding VPN and virtual adapters.
  if (-not $modem) {
    $modem = Get-NetIPConfiguration |
      Where-Object {
        $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway -and
        $_.InterfaceAlias -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v|vethernet|loopback' -and
        $_.InterfaceDescription -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v|virtual|loopback'
      } |
      Sort-Object @{ Expression = { $_.NetIPv4Interface.InterfaceMetric } } |
      Select-Object -First 1
  }
}
if (-not $modem -or -not $modem.IPv4Address -or -not $modem.IPv4DefaultGateway) {
  throw 'Active physical modem/uplink was not detected. Pass -InterfaceAlias explicitly if its name is different.'
}

$localAddress = [string]$modem.IPv4Address[0].IPAddress
$gateway = [string]$modem.IPv4DefaultGateway.NextHop
$ifIndex = [int]$modem.InterfaceIndex
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $OutputRoot $stamp
$currentWorking = Join-Path $OutputRoot 'current-working'
New-Item -ItemType Directory -Force -Path $runDirectory,$currentWorking | Out-Null

$providers = if ($Provider -eq 'all') { @('cloudflare','tencent','alibaba') } else { @($Provider) }

Write-Host '=== CDN backup test through TM ==='
Write-Host "Selected modem/uplink: $($modem.InterfaceAlias) (index $ifIndex)"
Write-Host "Local IPv4: $localAddress"
Write-Host "Gateway: $gateway"
Write-Host "Providers: $($providers -join ', ')"
Write-Host "Live result directory: $runDirectory"
Write-Host 'Only candidate /16 networks receive temporary TM routes; the default Starlink route is not changed.'
Write-Host ''

foreach ($name in $providers) {
  $sourceList = Join-Path $CandidateDirectory "$name-candidates.txt"
  if (-not (Test-Path -LiteralPath $sourceList)) { throw "Candidate list not found: $sourceList" }
  $candidates = @(Get-Content -LiteralPath $sourceList |
    ForEach-Object { if ($_ -match '^\s*((?:\d{1,3}\.){3}\d{1,3})\s*$') { $Matches[1] } } |
    Select-Object -Unique |
    Select-Object -First $LimitPerProvider)
  if ($candidates.Count -eq 0) { throw "No IPv4 candidates in $sourceList" }

  $selectedList = Join-Path $runDirectory "$name-selected-candidates.txt"
  [IO.File]::WriteAllLines($selectedList,$candidates,$utf8)
  $prefixes = @($candidates | ForEach-Object {
    $parts = $_.Split('.')
    "$($parts[0]).$($parts[1]).0.0/16"
  } | Select-Object -Unique)

  $createdRoutes = [Collections.Generic.List[object]]::new()
  try {
    foreach ($prefix in $prefixes) {
      $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
      if ($existing) { continue }
      $route = New-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex `
        -NextHop $gateway -RouteMetric 1 -PolicyStore ActiveStore
      foreach ($row in @($route)) { $createdRoutes.Add($row) }
    }

    $selectedRoute = Find-NetRoute -RemoteIPAddress $candidates[0]
    if ($selectedRoute.InterfaceIndex -ne $ifIndex) {
      throw "Route verification failed: $($candidates[0]) is not routed through $($modem.InterfaceAlias)."
    }

    $report = Join-Path $runDirectory "$name-report.json"
    $foundJsonl = Join-Path $runDirectory "$name-working.jsonl"
    $foundIps = Join-Path $runDirectory "$name-working.txt"
    $arguments = @(
      $scanner,
      "--provider=$name",
      "--limit=$LimitPerProvider",
      "--concurrency=$Concurrency",
      "--timeout=$TimeoutMs",
      "--progress-every=$ProgressEvery",
      "--top=$Top",
      "--local=$localAddress",
      "--out=$report",
      "--found-out=$foundJsonl",
      "--found-ips-out=$foundIps"
    )
    switch ($name) {
      'cloudflare' {
        $arguments += "--cloudflare-edge-list=$selectedList","--cloudflare-strict-edge-list=true","--cloudflare-host=$CloudflareHost","--cloudflare-path=$CloudflarePath"
      }
      'tencent' {
        $arguments += "--tencent-edge-list=$selectedList","--tencent-sni=$TencentSni","--tencent-host=$TencentHost","--tencent-path=$TencentPath","--tencent-application-limit=$LimitPerProvider"
      }
      'alibaba' {
        $arguments += "--alibaba-edge-list=$selectedList","--alibaba-strict-edge-list=true","--alibaba-mode=$AlibabaMode","--alibaba-sni=$AlibabaSni","--alibaba-host=$AlibabaHost","--alibaba-path=$AlibabaPath"
      }
    }

    Write-Host "--- Testing $name ($($candidates.Count) candidates) ---"
    Write-Host "Working IPs are written immediately to: $foundIps"
    & node @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$name scanner exited with code $LASTEXITCODE. Partial results remain in $foundIps"
    }
    Copy-Item -LiteralPath $foundIps -Destination (Join-Path $currentWorking "$name-working.txt") -Force
  } finally {
    foreach ($route in $createdRoutes) {
      $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host "Temporary $name routes removed."
    Write-Host ''
  }
}

[IO.File]::WriteAllText((Join-Path $OutputRoot 'latest-run.txt'),"$runDirectory`r`n",$utf8)
Write-Host 'TM tests completed.'
Write-Host "Latest working lists: $currentWorking"
Write-Host "Detailed run: $runDirectory"
