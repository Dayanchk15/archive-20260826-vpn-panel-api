param(
  [int]$Limit = 30000,
  [int]$Concurrency = 24,
  [int]$TimeoutMs = 5000,
  [int]$ApplicationLimit = 3000,
  [int]$Top = 100,
  [int]$SamplesPerPrefix = 12,
  [string]$LocalAddress = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$candidateFile = Join-Path $repo 'ops\ip-lists\tencent-edgeone-expanded-current.txt'
node .\scripts\build-tencent-edgeone-candidates.mjs `
  --out="$candidateFile" `
  --asns=AS139341,AS132203 `
  --samples=$SamplesPerPrefix
if ($LASTEXITCODE -ne 0) { throw 'Tencent candidate generation failed' }

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
  if ($adapter) { $LocalAddress = $adapter.IPv4Address[0].IPAddress }
}
if (-not $LocalAddress) { throw 'Physical IPv4 interface was not detected. Pass -LocalAddress explicitly.' }

$outputDirectory = Join-Path $repo 'tmp'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $outputDirectory "tm-tencent-expanded-$stamp.json"
$foundJsonl = Join-Path $outputDirectory "tm-tencent-expanded-$stamp.found.jsonl"
$foundIps = Join-Path $outputDirectory "tm-tencent-expanded-$stamp.found.txt"

Write-Host '=== Expanded Tencent EdgeOne scan ==='
Write-Host "Candidate list: $candidateFile"
Write-Host "Bound IPv4: $LocalAddress"
Write-Host "Confirmed WS 101 IPs are written immediately to: $foundIps"
Write-Host "Live details: $foundJsonl"
Write-Host "Final report: $out"
Write-Host 'Progress will be printed every 250 checks. Confirmed IP files remain empty until the WS stage finds HTTP 101.'
Write-Host ''

node .\scripts\tm-cdn-ip-scan.mjs `
  --provider=tencent `
  --limit=$Limit `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --top=$Top `
  --local=$LocalAddress `
  --out=$out `
  --found-out=$foundJsonl `
  --found-ips-out=$foundIps `
  --tencent-edge-list=$candidateFile `
  --tencent-application-limit=$ApplicationLimit `
  --tencent-sni=www.tencentwm.com `
  --tencent-host=daykoo-tencent-fr1.levospeed.click `
  --tencent-path=/

if ($LASTEXITCODE -ne 0) {
  throw "Expanded Tencent scan failed. Partial findings remain in $foundIps"
}
