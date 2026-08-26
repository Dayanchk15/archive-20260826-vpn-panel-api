param(
  [int]$Limit = 1400,
  [int]$Concurrency = 8,
  [int]$TimeoutMs = 5500,
  [int]$Top = 60,
  [string]$LocalAddress = "",
  [ValidateSet("xhttp", "ws")]
  [string]$Mode = "ws",
  [string]$AlibabaSni = "www.alibaba.com",
  [string]$AlibabaHost = "cdn-a1.levospeed.click",
  [string]$AlibabaPath = "/",
  [string]$AlibabaEdgeList = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $AlibabaEdgeList) {
  $AlibabaEdgeList = Join-Path $repo "ops\ip-lists\alibaba-esa-tm-seeds.txt"
}

if (-not $LocalAddress) {
  $candidate = Get-NetIPConfiguration |
    Where-Object {
      $_.IPv4DefaultGateway -and
      $_.IPv4Address -and
      $_.NetAdapter.Status -eq "Up" -and
      $_.InterfaceAlias -notmatch "tun|tap|vpn|tailscale|wsl|vmware|hyper-v" -and
      $_.InterfaceDescription -notmatch "tun|tap|vpn|tailscale|wsl|vmware|hyper-v"
    } |
    Select-Object -First 1

  if ($candidate) {
    $LocalAddress = $candidate.IPv4Address[0].IPAddress
  }
}

if (-not $LocalAddress) {
  throw "Physical TM interface was not detected. Pass -LocalAddress explicitly."
}

$tmp = Join-Path $repo "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $tmp "tm-alibaba-esa-$stamp.json"
$foundOut = Join-Path $tmp "tm-alibaba-esa-$stamp.found.jsonl"
$foundIpsOut = Join-Path $tmp "tm-alibaba-esa-$stamp.found.txt"

Write-Host "=== Alibaba ESA TM scan ==="
Write-Host "Bound physical IPv4: $LocalAddress"
Write-Host "Mode: $Mode"
Write-Host "SNI: $AlibabaSni"
Write-Host "Host: $AlibabaHost"
Write-Host "Path: $AlibabaPath"
Write-Host "Seed list: $AlibabaEdgeList"
Write-Host "Confirmed IPs: $foundIpsOut"
Write-Host "Final report: $out"
Write-Host ""

node .\scripts\tm-cdn-ip-scan.mjs `
  --provider=alibaba `
  --limit=$Limit `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --top=$Top `
  --local=$LocalAddress `
  --out=$out `
  --found-out=$foundOut `
  --found-ips-out=$foundIpsOut `
  --alibaba-sni=$AlibabaSni `
  --alibaba-mode=$Mode `
  --alibaba-host=$AlibabaHost `
  --alibaba-path=$AlibabaPath `
  --alibaba-edge-list=$AlibabaEdgeList

if ($LASTEXITCODE -ne 0) {
  throw "Alibaba ESA scan failed with exit code $LASTEXITCODE. Partial results remain in $foundIpsOut"
}

Write-Host ""
Write-Host "Confirmed Alibaba ESA IPs:"
Get-Content $foundIpsOut -ErrorAction SilentlyContinue
