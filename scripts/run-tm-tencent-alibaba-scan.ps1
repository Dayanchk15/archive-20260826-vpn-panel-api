param(
  [int]$Limit = 800,
  [int]$Concurrency = 5,
  [int]$TimeoutMs = 6000,
  [int]$Top = 50,
  [string]$LocalAddress = "",
  [string]$TencentEdgeList = "",
  [string]$AlibabaEdgeList = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($LocalAddress) {
  $env:LOCAL_ADDRESS = $LocalAddress
} else {
  Remove-Item Env:\LOCAL_ADDRESS -ErrorAction SilentlyContinue
}

$tmp = Join-Path $repo "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $tmp "tm-tencent-alibaba-$stamp.json"
$foundOut = Join-Path $tmp "tm-tencent-alibaba-$stamp.found.jsonl"
$foundIpsOut = Join-Path $tmp "tm-tencent-alibaba-$stamp.found.txt"

Write-Host ""
Write-Host "=== Active default routes ==="
Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric |
  Select-Object -First 8 InterfaceAlias,NextHop,RouteMetric,InterfaceMetric |
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== Active IPv4 interfaces ==="
Get-NetIPConfiguration |
  Where-Object { $_.IPv4DefaultGateway -or $_.NetAdapter.Status -eq "Up" } |
  Select-Object InterfaceAlias,InterfaceDescription,
    @{n='IPv4';e={$_.IPv4Address.IPAddress -join ','}},
    @{n='Gateway';e={$_.IPv4DefaultGateway.NextHop -join ','}} |
  Format-Table -AutoSize

Write-Host ""
Write-Host "Starting Tencent EdgeOne + Alibaba ESA scan..."
Write-Host "Every confirmed IP is fsync'ed immediately to:"
Write-Host "  $foundIpsOut"
Write-Host "Detailed live rows:"
Write-Host "  $foundOut"
Write-Host "Final report:"
Write-Host "  $out"
Write-Host ""

node .\scripts\tm-cdn-ip-scan.mjs `
  --provider=asia `
  --limit=$Limit `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --top=$Top `
  --out=$out `
  --found-out=$foundOut `
  --found-ips-out=$foundIpsOut `
  --tencent-edge-list=$TencentEdgeList `
  --alibaba-edge-list=$AlibabaEdgeList

if ($LASTEXITCODE -ne 0) {
  throw "Tencent/Alibaba scan failed with exit code $LASTEXITCODE. Partial findings remain in $foundIpsOut"
}

Write-Host ""
Write-Host "Scan complete. Confirmed IPs were already saved during the scan:"
Get-Content $foundIpsOut -ErrorAction SilentlyContinue

