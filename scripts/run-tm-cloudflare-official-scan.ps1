param(
  [string]$InterfaceAlias = '',
  [int]$Concurrency = 6,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,5)]
  [int]$Passes = 2,
  [int]$Top = 50,
  [string]$BaseList = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if (-not $BaseList) { $BaseList = Join-Path $repo 'ops\ip-lists\cloudflare-current-candidates.txt' }
$base = (Resolve-Path -LiteralPath $BaseList -ErrorAction Stop).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $repo "tmp\tm-cloudflare-official-$stamp"
$candidateFile = Join-Path $runRoot 'cloudflare-candidates.txt'
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

$known = @('162.211.228.47')
$ips = @($known + (Get-Content -LiteralPath $base)) |
  ForEach-Object { if ($_ -match '^\s*((?:\d{1,3}\.){3}\d{1,3})\s*$') { $Matches[1] } } |
  Select-Object -Unique
if (-not $ips.Count) { throw "No Cloudflare candidates found in $base" }
[IO.File]::WriteAllLines($candidateFile, $ips, [Text.UTF8Encoding]::new($false))

Write-Host "Official Cloudflare candidates: $($ips.Count)"
Write-Host "Known candidate first: 162.211.228.47"
Write-Host 'Validation: TCP 443 + TLS SNI fr1.levospeed.online + WebSocket HTTP 101.'
Write-Host 'TLS fragmentation: disabled.'
Write-Host ''

& (Join-Path $PSScriptRoot 'run-tm-verify-cf-list.ps1') `
  -InputFile $candidateFile `
  -InterfaceAlias $InterfaceAlias `
  -Concurrency $Concurrency `
  -TimeoutMs $TimeoutMs `
  -Passes $Passes `
  -Top $Top `
  -OutputRoot $runRoot
exit $LASTEXITCODE
