param(
  [string]$InterfaceAlias = '',
  [int]$Limit = 6000,
  [int]$Concurrency = 40,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,5)]
  [int]$Passes = 3,
  [int]$Top = 100,
  [string]$CandidateFile = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'run-tm-cloudflare-alibaba-fast-scan.ps1'
$arguments = @{
  Provider = 'alibaba'
  InterfaceAlias = $InterfaceAlias
  AlibabaLimit = $Limit
  Concurrency = $Concurrency
  TimeoutMs = $TimeoutMs
  Passes = $Passes
  Top = $Top
}
if ($CandidateFile) { $arguments.AlibabaCandidateFile = $CandidateFile }

Write-Host 'Alibaba scan mode: VLESS + WebSocket + TLS'
Write-Host 'Required application result: HTTP 101 Switching Protocols'
Write-Host 'SNI: www.alibaba.com'
Write-Host 'Host: cdn-a1.levospeed.click'
Write-Host 'Path: /'
Write-Host ''

& $script @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
