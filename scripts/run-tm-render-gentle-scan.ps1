param(
  [string]$InterfaceAlias = '',
  [int]$Concurrency = 6,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,5)]
  [int]$Passes = 3,
  [int]$Top = 50
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$candidateFile = Join-Path $repo 'ops\ip-lists\render-as397273-candidates.txt'

node (Join-Path $PSScriptRoot 'build-render-front-candidates.mjs') $candidateFile
if ($LASTEXITCODE -ne 0) { throw 'Render candidate preparation failed.' }

$all = @(Get-Content -LiteralPath $candidateFile | Where-Object { $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' } | Select-Object -Unique)
$priority = @('216.24.57.1') + @($all | Where-Object { $_ -ne '216.24.57.1' })
[IO.File]::WriteAllLines($candidateFile, $priority, [Text.UTF8Encoding]::new($false))

Write-Host 'Gentle Render/Cloudflare-host scan without TLS fragmentation'
Write-Host "Candidates: $($priority.Count)"
Write-Host "Concurrency: $Concurrency"
Write-Host "Timeout: $TimeoutMs ms"
Write-Host 'Known working IP 216.24.57.1 is tested first.'
Write-Host 'An IP qualifies only after valid TLS and WebSocket HTTP 101.'
Write-Host ''

& (Join-Path $PSScriptRoot 'run-tm-cloudflare-alibaba-fast-scan.ps1') `
  -Provider cloudflare `
  -CloudflareCandidateFile $candidateFile `
  -CloudflareLimit 600 `
  -Concurrency $Concurrency `
  -TimeoutMs $TimeoutMs `
  -ProgressEvery 10 `
  -Passes $Passes `
  -Top $Top `
  -InterfaceAlias $InterfaceAlias

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
