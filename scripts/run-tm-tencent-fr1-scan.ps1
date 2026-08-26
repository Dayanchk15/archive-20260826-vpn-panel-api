param(
  [string]$InterfaceAlias = '',
  [string]$LocalAddress = '',
  [int]$Limit = 30000,
  [int]$Concurrency = 80,
  [int]$TimeoutMs = 3500,
  [int]$ApplicationLimit = 6000,
  [int]$Top = 100,
  [string]$CandidateFile = '',
  [switch]$RefreshCandidates
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$candidateSource = if ($CandidateFile) { (Resolve-Path -LiteralPath $CandidateFile -ErrorAction Stop).Path } else { Join-Path $repo 'ops\ip-lists\tencent-edgeone-expanded-current.txt' }
$candidateSelected = Join-Path $repo 'tmp\tencent-fr1-tm-selected.txt'
$scanner = Join-Path $repo 'scripts\tm-cdn-ip-scan.mjs'
$utf8 = [Text.UTF8Encoding]::new($false)

if ($CandidateFile) {
  Write-Host "Using explicit Tencent candidate file: $candidateSource"
} elseif ($RefreshCandidates -or -not (Test-Path -LiteralPath $candidateSource)) {
  node .\scripts\build-tencent-edgeone-candidates.mjs `
    --out="$candidateSource" `
    --asns=AS139341,AS132203 `
    --samples=12
  if ($LASTEXITCODE -ne 0) { throw 'Tencent candidate generation failed' }
}

if (-not (Test-Path -LiteralPath $candidateSource)) {
  throw "Candidate list not found: $candidateSource"
}
if (-not (Test-Path -LiteralPath $scanner)) { throw "Scanner not found: $scanner" }

if ($InterfaceAlias) {
  $uplink = Get-NetIPConfiguration -InterfaceAlias $InterfaceAlias -ErrorAction Stop
} else {
  $uplink = Get-NetIPConfiguration |
    Where-Object {
      $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway -and
      $_.InterfaceAlias -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v|vethernet|loopback' -and
      $_.InterfaceDescription -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v|virtual|loopback'
    } |
    Sort-Object @{ Expression = { $_.NetIPv4Interface.InterfaceMetric } } |
    Select-Object -First 1
}
if (-not $uplink -or -not $uplink.IPv4DefaultGateway) {
  throw 'Physical TM uplink was not detected. Pass -InterfaceAlias explicitly.'
}

if (-not $LocalAddress) { $LocalAddress = [string]$uplink.IPv4Address[0].IPAddress }
$gateway = [string]$uplink.IPv4DefaultGateway.NextHop
$ifIndex = [int]$uplink.InterfaceIndex

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator. Temporary routes are required so the scan cannot leak through VPN.'
}

$pinned = @(
  '43.159.98.111',
  '43.159.99.106',
  '43.159.109.61',
  '43.174.224.189',
  '43.174.224.133',
  '43.174.196.76',
  '43.159.99.61'
)
$blockedOrFalse = @('43.157.64.8')
$source = @(Get-Content -LiteralPath $candidateSource |
  ForEach-Object { if ($_ -match '^\s*((?:\d{1,3}\.){3}\d{1,3})\s*$') { $Matches[1] } })
$candidates = @($pinned + $source |
  Where-Object { $_ -and $_ -notin $blockedOrFalse } |
  Select-Object -Unique |
  Select-Object -First $Limit)
if (-not $candidates.Count) { throw 'Tencent candidate list is empty' }

New-Item -ItemType Directory -Force -Path (Join-Path $repo 'tmp') | Out-Null
[IO.File]::WriteAllLines($candidateSelected, $candidates, $utf8)

$prefixes = @($candidates | ForEach-Object {
  $parts = $_.Split('.')
  "$($parts[0]).$($parts[1]).0.0/16"
} | Select-Object -Unique)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $repo "tmp\tm-tencent-fr1-$stamp.json"
$foundJsonl = Join-Path $repo "tmp\tm-tencent-fr1-$stamp.found.jsonl"
$foundIps = Join-Path $repo "tmp\tm-tencent-fr1-$stamp.found.txt"
$createdRoutes = [Collections.Generic.List[object]]::new()

Write-Host '=== Tencent FR1 scan through TM ==='
Write-Host "Interface: $($uplink.InterfaceAlias)"
Write-Host "Local IPv4: $LocalAddress"
Write-Host "Gateway: $gateway"
Write-Host "Candidates: $($candidates.Count)"
Write-Host 'SNI: www.tencentwm.com'
Write-Host 'Host: daykoo-tencent-fr1.levospeed.click'
Write-Host 'WebSocket path: /'
Write-Host "Live confirmed IPs: $foundIps"
Write-Host "Final report: $out"
Write-Host 'Only IPs with valid TLS identity/date and WebSocket HTTP 101 are saved.'
Write-Host ''

try {
  foreach ($prefix in $prefixes) {
    $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
    if ($existing) { continue }
    $route = New-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex `
      -NextHop $gateway -RouteMetric 1 -PolicyStore ActiveStore
    foreach ($row in @($route)) { $createdRoutes.Add($row) }
  }

  $routeCheck = Find-NetRoute -RemoteIPAddress $candidates[0]
  if ($routeCheck.InterfaceIndex -ne $ifIndex) {
    throw "Route verification failed: $($candidates[0]) is not using $($uplink.InterfaceAlias)"
  }

  node $scanner `
    --provider=tencent `
    --limit=$($candidates.Count) `
    --concurrency=$Concurrency `
    --timeout=$TimeoutMs `
    --top=$Top `
    --local=$LocalAddress `
    --out=$out `
    --found-out=$foundJsonl `
    --found-ips-out=$foundIps `
    --tencent-edge-list=$candidateSelected `
    --tencent-application-limit=$ApplicationLimit `
    --tencent-sni=www.tencentwm.com `
    --tencent-host=daykoo-tencent-fr1.levospeed.click `
    --tencent-path=/

  if ($LASTEXITCODE -ne 0) {
    throw "Tencent FR1 scan failed. Partial findings remain in $foundIps"
  }
} finally {
  foreach ($route in $createdRoutes) {
    $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host "Temporary TM routes removed: $($createdRoutes.Count)"
}

$confirmed = @(Get-Content -LiteralPath $foundIps -ErrorAction SilentlyContinue |
  ForEach-Object { ($_ -split ',')[-1].Trim() } |
  Where-Object { $_ })
Write-Host ''
Write-Host "Confirmed Tencent FR1 IPs: $($confirmed.Count)"
$confirmed | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host 'The script does not change the panel or client subscriptions.'
