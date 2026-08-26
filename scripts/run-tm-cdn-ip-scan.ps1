param(
  [ValidateSet("all", "bunny", "fastly", "tencent", "edgeone", "alibaba", "esa", "asia")]
  [string]$Provider = "all",

  [int]$Limit = 350,
  [int]$Concurrency = 35,
  [int]$TimeoutMs = 4500,

  # Leave empty for auto-detect. Use this when phone modem has a known IP like 172.20.10.2.
  [string]$LocalAddress = "",

  [string]$BunnyHost = "levospeedfr2.b-cdn.net",
  [string]$BunnyPath = "/media/v5/fr2/vless",
  [string]$BunnyEdgeList = "",
  [int]$BunnyApplicationLimit = 220,

  [string]$FastlySni = "manage.fastly.com",
  [string]$FastlyHost = "painfully-super-puma.global.ssl.fastly.net",
  [string]$FastlyPath = "/",

  [string]$TencentSni = "www.tencentwm.com",
  [string]$TencentHost = "daykoo-tencent-fr1.levospeed.click",
  [string]$TencentPath = "/eo/v1/4bfa6f260da5",
  [string]$TencentEdgeList = "",

  [string]$AlibabaSni = "www.alibaba.com",
  [string]$AlibabaHost = "cdn-a1.levospeed.click",
  [string]$AlibabaPath = "/media/v4/fr1/sync",
  [string]$AlibabaEdgeList = "",
  [string]$AlibabaDiscoveryHosts = "cdn-a1.levospeed.click,cdn-a2.levospeed.click,cdn-a3.levospeed.click,cdn-a4.levospeed.click",

  [string]$Out = "",
  [string]$FoundOut = "",
  [string]$FoundIpsOut = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($LocalAddress) {
  $env:LOCAL_ADDRESS = $LocalAddress
} else {
  Remove-Item Env:\LOCAL_ADDRESS -ErrorAction SilentlyContinue
}

if (-not $Out) {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo "tmp") | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Out = Join-Path $repo "tmp\tm-cdn-ip-scan-$stamp.json"
}

node .\scripts\tm-cdn-ip-scan.mjs `
  --provider=$Provider `
  --limit=$Limit `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --out=$Out `
  --found-out=$FoundOut `
  --found-ips-out=$FoundIpsOut `
  --bunny-host=$BunnyHost `
  --bunny-path=$BunnyPath `
  --bunny-edge-list=$BunnyEdgeList `
  --bunny-application-limit=$BunnyApplicationLimit `
  --fastly-sni=$FastlySni `
  --fastly-host=$FastlyHost `
  --fastly-path=$FastlyPath `
  --tencent-sni=$TencentSni `
  --tencent-host=$TencentHost `
  --tencent-path=$TencentPath `
  --tencent-edge-list=$TencentEdgeList `
  --alibaba-sni=$AlibabaSni `
  --alibaba-host=$AlibabaHost `
  --alibaba-path=$AlibabaPath `
  --alibaba-edge-list=$AlibabaEdgeList `
  --alibaba-discovery-hosts=$AlibabaDiscoveryHosts
