param(
  [string]$InputFile = 'C:\Users\Admin\Desktop\cdn-ip-scans\alibaba-esa\results-ali-HUGE-OK.txt',
  [string]$LocalAddress = '',
  [int]$Concurrency = 12,
  [int]$TimeoutMs = 4500,
  [int]$MaxSourceMs = 0,
  [int]$MaxTcpMs = 1500,
  [int]$MaxTlsMs = 2500,
  [int]$MaxAppMs = 3500,
  [int]$Passes = 3,
  [ValidateSet('all', 'fr1', 'fr2', 'fornex', 'tampa')]
  [string]$Target = 'all',
  [int]$Limit = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "Input file not found: $InputFile"
}

if (-not $LocalAddress) {
  $adapter = Get-NetIPConfiguration |
    Where-Object {
      $_.IPv4DefaultGateway -and
      $_.IPv4Address -and
      $_.NetAdapter.Status -eq 'Up' -and
      $_.InterfaceAlias -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v' -and
      $_.InterfaceDescription -notmatch 'tun|tap|vpn|tailscale|wsl|vmware|hyper-v'
    } |
    Sort-Object @{ Expression = { $_.NetIPv4Interface.ConnectionMetric } } |
    Select-Object -First 1
  if ($adapter) {
    $LocalAddress = $adapter.IPv4Address[0].IPAddress
  }
}

if (-not $LocalAddress) {
  throw 'Physical IPv4 interface was not detected. Pass -LocalAddress explicitly.'
}

$outputDirectory = Split-Path -Parent (Resolve-Path -LiteralPath $InputFile)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prefix = Join-Path $outputDirectory "alibaba-ws-qualified-$stamp"
$outIps = "$prefix.txt"
$outJsonl = "$prefix.jsonl"
$outFailures = "$prefix.failures.jsonl"
$outReport = "$prefix.report.json"

Write-Host '=== Alibaba ESA VLESS WS TLS criteria scan ==='
Write-Host "Input: $InputFile"
Write-Host "Bound IPv4: $LocalAddress"
Write-Host "Qualified IPs are written immediately to: $outIps"
Write-Host "Per-host lists: $prefix.fr1.txt, $prefix.fr2.txt, $prefix.fornex.txt, $prefix.tampa.txt"
Write-Host "Detailed live results: $outJsonl"
Write-Host "Detailed failures: $outFailures"
Write-Host "Final report: $outReport"
Write-Host ''

node .\scripts\filter-alibaba-esa-candidates.mjs `
  --input="$InputFile" `
  --local="$LocalAddress" `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --max-source-ms=$MaxSourceMs `
  --max-tcp-ms=$MaxTcpMs `
  --max-tls-ms=$MaxTlsMs `
  --max-app-ms=$MaxAppMs `
  --passes=$Passes `
  --target=$Target `
  --limit=$Limit `
  --out-ips="$outIps" `
  --out-jsonl="$outJsonl" `
  --out-failures="$outFailures" `
  --out-report="$outReport"

if ($LASTEXITCODE -ne 0) {
  throw "Alibaba qualifier exited with code $LASTEXITCODE. Findings already written to $outIps"
}

Write-Host ''
Write-Host "Done. Qualified IPs: $outIps"
