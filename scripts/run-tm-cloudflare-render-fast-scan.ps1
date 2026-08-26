param(
  [string]$InterfaceAlias = '',
  [int]$Concurrency = 40,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,5)]
  [int]$Passes = 3,
  [int]$Top = 50
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$candidateFile = Join-Path $repo 'ops\ip-lists\render-as397273-candidates.txt'

$proxyNames = @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY')
$proxyBackup = @{}
foreach ($name in $proxyNames) {
  $proxyBackup[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$env:NODE_USE_ENV_PROXY = '0'
try {
  node (Join-Path $PSScriptRoot 'build-render-front-candidates.mjs') $candidateFile
  if ($LASTEXITCODE -ne 0) { throw 'Render candidate generation failed.' }
} finally {
  foreach ($name in $proxyNames) {
    [Environment]::SetEnvironmentVariable($name, $proxyBackup[$name], 'Process')
  }
}

Write-Host ''
Write-Host 'Alternate Cloudflare-host front scan: Render AS397273'
Write-Host 'Known working control IP: 216.24.57.1'
Write-Host 'Protocol: VLESS + WebSocket + TLS'
Write-Host 'Host/SNI: fr1.levospeed.online'
Write-Host 'Required response: HTTP 101 Switching Protocols'
Write-Host ''

$arguments = @{
  Provider = 'cloudflare'
  CloudflareCandidateFile = $candidateFile
  CloudflareLimit = 600
  Concurrency = $Concurrency
  TimeoutMs = $TimeoutMs
  Passes = $Passes
  Top = $Top
  InterfaceAlias = $InterfaceAlias
}
& (Join-Path $PSScriptRoot 'run-tm-cloudflare-alibaba-fast-scan.ps1') @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
