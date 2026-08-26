param(
  [int]$Limit = 5000,
  [int]$Concurrency = 50,
  [int]$TimeoutMs = 7000,
  [string]$LocalAddress = "",
  [string]$BunnyHost = "levospeed.it.com",
  [string]$BunnyPath = "/",
  [int]$BunnyApplicationLimit = 300,
  [string]$BunnyEdgeList = "",
  [string]$Out = "",
  [string]$FoundOut = "",
  [string]$FoundIpsOut = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Refresh the official Bunny inventory, ASN prefixes and the current domain A record.
node .\scripts\build-bunny-asn-ip-list.mjs $BunnyHost
if ($LASTEXITCODE -ne 0) {
  throw "Failed to refresh Bunny candidate IP list."
}

if (-not $BunnyEdgeList) {
  $merged = Join-Path $repo "tmp\bunny-all-candidates-merged.txt"
  $static = Join-Path $repo "tmp\bunny-edges-static.txt"
  if (Test-Path $merged) {
    $BunnyEdgeList = $merged
  } else {
    $BunnyEdgeList = $static
  }
}

$scanArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", ".\scripts\run-tm-cdn-ip-scan.ps1",
  "-Provider", "bunny",
  "-Limit", "$Limit",
  "-Concurrency", "$Concurrency",
  "-TimeoutMs", "$TimeoutMs",
  "-BunnyHost", "$BunnyHost",
  "-BunnyPath", "$BunnyPath",
  "-BunnyEdgeList", "$BunnyEdgeList",
  "-BunnyApplicationLimit", "$BunnyApplicationLimit"
)

if ($LocalAddress) {
  $scanArgs += @("-LocalAddress", "$LocalAddress")
}
if ($Out) { $scanArgs += @("-Out", "$Out") }
if ($FoundOut) { $scanArgs += @("-FoundOut", "$FoundOut") }
if ($FoundIpsOut) { $scanArgs += @("-FoundIpsOut", "$FoundIpsOut") }

powershell @scanArgs
