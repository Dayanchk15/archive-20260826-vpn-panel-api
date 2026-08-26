param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,
  [string]$InterfaceAlias = '',
  [int]$Concurrency = 6,
  [int]$TimeoutMs = 7000,
  [ValidateRange(1,5)]
  [int]$Passes = 2,
  [int]$Top = 50,
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$source = (Resolve-Path -LiteralPath $InputFile -ErrorAction Stop).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workRoot = Join-Path $repo "tmp\tm-verify-cf-$stamp"
$candidateFile = Join-Path $workRoot 'cloudflare-candidates.txt'
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

$text = Get-Content -LiteralPath $source -Raw
$ips = [Collections.Generic.List[string]]::new()
foreach ($match in [regex]::Matches($text, '\b(?:\d{1,3}\.){3}\d{1,3}\b')) {
  $ip = $match.Value
  $octets = $ip.Split('.') | ForEach-Object { [int]$_ }
  if ($octets.Count -eq 4 -and ($octets | Where-Object { $_ -lt 0 -or $_ -gt 255 }).Count -eq 0) {
    if (-not $ips.Contains($ip)) { $ips.Add($ip) }
  }
}
if (-not $ips.Count) { throw "No IPv4 addresses found in $source" }
[IO.File]::WriteAllLines($candidateFile, $ips, [Text.UTF8Encoding]::new($false))

Write-Host "TM verification candidates: $($ips.Count)"
Write-Host "Source: $source"
Write-Host "Candidate list: $candidateFile"
Write-Host 'Required result: TCP + valid TLS for fr1.levospeed.online + WebSocket HTTP 101.'
Write-Host 'TLS fragmentation is not enabled.'
Write-Host ''

$args = @{
  Provider = 'cloudflare'
  CloudflareCandidateFile = $candidateFile
  CloudflareLimit = $ips.Count
  Concurrency = $Concurrency
  TimeoutMs = $TimeoutMs
  ProgressEvery = 10
  Passes = $Passes
  Top = $Top
  InterfaceAlias = $InterfaceAlias
}
if ($OutputRoot) { $args.OutputRoot = $OutputRoot }
& (Join-Path $PSScriptRoot 'run-tm-cloudflare-alibaba-fast-scan.ps1') @args
exit $LASTEXITCODE
