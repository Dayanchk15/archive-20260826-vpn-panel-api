param(
  [string]$InputFile = 'C:\Users\Admin\Desktop\cdn-ip-scans\alibaba-esa\results-ali-HUGE-OK.txt',
  [int]$Concurrency = 4,
  [int]$TimeoutMs = 15000,
  [int]$MaxTcpMs = 12000,
  [int]$MaxTlsMs = 12000,
  [int]$MaxAppMs = 15000,
  [int]$Passes = 1,
  [ValidateSet('all', 'fr1', 'fr2', 'fornex', 'tampa')]
  [string]$Target = 'fr1',
  [int]$Limit = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-tm-alibaba-qualified-scan.ps1'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator. Administrator rights are needed only for temporary Alibaba routes.'
}
if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "Input file not found: $InputFile"
}

$modem = Get-NetIPConfiguration |
  Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and
    $_.NetAdapter.InterfaceDescription -match 'Remote NDIS|RNDIS|USB.*(Ethernet|Internet)|Mobile' -and
    $_.IPv4Address -and
    $_.IPv4DefaultGateway
  } |
  Select-Object -First 1

if (-not $modem) {
  throw 'Active USB modem was not found. Enable USB tethering and check that Remote NDIS is Up.'
}

$modemIp = $modem.IPv4Address[0].IPAddress
$gateway = $modem.IPv4DefaultGateway.NextHop
$ifIndex = $modem.InterfaceIndex
$interfaceName = $modem.InterfaceAlias

$prefixSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$firstCandidate = $null
foreach ($line in [IO.File]::ReadLines($InputFile)) {
  if ($line -notmatch '^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b') { continue }
  $octets = 1..4 | ForEach-Object { [int]$Matches[$_] }
  if ($octets | Where-Object { $_ -gt 255 }) { continue }
  if (-not $firstCandidate) { $firstCandidate = $octets -join '.' }
  [void]$prefixSet.Add("$($octets[0]).$($octets[1]).0.0/16")
}
if ($prefixSet.Count -eq 0) {
  throw 'No IPv4 candidates were found in the input file.'
}

Write-Host '=== TM Alibaba scan through USB modem ==='
Write-Host "USB interface: $interfaceName (index $ifIndex)"
Write-Host "USB local IPv4: $modemIp"
Write-Host "USB gateway: $gateway"
Write-Host "Alibaba route prefixes: $($prefixSet.Count)"
Write-Host "Discovery target: $Target"
Write-Host 'Starlink remains the default route for ChatGPT and all non-Alibaba traffic.'
Write-Host ''

$createdRoutes = [Collections.Generic.List[object]]::new()
$scanExitCode = 0
try {
  foreach ($prefix in $prefixSet) {
    $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
    if ($existing) { continue }
    $route = New-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex `
      -NextHop $gateway -RouteMetric 1 -PolicyStore ActiveStore
    $createdRoutes.Add($route)
  }

  $selected = Find-NetRoute -RemoteIPAddress $firstCandidate
  if ($selected.InterfaceIndex -ne $ifIndex) {
    throw "Route verification failed: $firstCandidate is not routed through $interfaceName."
  }
  Write-Host "Route check OK: $firstCandidate -> $interfaceName"
  Write-Host ''

  & $runner `
    -InputFile $InputFile `
    -LocalAddress $modemIp `
    -Concurrency $Concurrency `
    -TimeoutMs $TimeoutMs `
    -MaxSourceMs 0 `
    -MaxTcpMs $MaxTcpMs `
    -MaxTlsMs $MaxTlsMs `
    -MaxAppMs $MaxAppMs `
    -Passes $Passes `
    -Target $Target `
    -Limit $Limit
  $scanExitCode = $LASTEXITCODE
} finally {
  Write-Host ''
  Write-Host 'Removing temporary USB-modem routes...'
  foreach ($route in $createdRoutes) {
    $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host 'Temporary routes removed. Starlink routing was not changed.'
}

if ($scanExitCode -ne 0) { exit $scanExitCode }
