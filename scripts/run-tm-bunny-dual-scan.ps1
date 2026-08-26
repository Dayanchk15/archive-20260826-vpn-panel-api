param(
  [int]$Limit = 500,
  [int]$Concurrency = 25,
  [int]$TimeoutMs = 7000,
  [string]$LocalAddress = "",
  [string]$BunnyEdgeList = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $BunnyEdgeList) {
  $merged = Join-Path $repo "tmp\bunny-all-candidates-merged.txt"
  $static = Join-Path $repo "tmp\bunny-edges-static.txt"
  if (Test-Path $merged) {
    $BunnyEdgeList = $merged
  } else {
    $BunnyEdgeList = $static
  }
}

function Invoke-BunnyScan {
  param(
    [string]$HostName,
    [string]$ProbePath
  )

  $scanArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", ".\scripts\run-tm-bunny-ip-scan.ps1",
    "-Limit", "$Limit",
    "-Concurrency", "$Concurrency",
    "-TimeoutMs", "$TimeoutMs",
    "-BunnyHost", "$HostName",
    "-BunnyPath", "$ProbePath",
    "-BunnyEdgeList", "$BunnyEdgeList"
  )

  if ($LocalAddress) {
    $scanArgs += @("-LocalAddress", "$LocalAddress")
  }

  powershell @scanArgs
}

Write-Host "=== Scan 1: our Bunny host levospeedfr2.b-cdn.net ==="
Invoke-BunnyScan -HostName "levospeedfr2.b-cdn.net" -ProbePath "/media/v5/fr2/vless"

Write-Host "=== Scan 2: competitor-like Bunny host rocko.b-cdn.net ==="
Invoke-BunnyScan -HostName "rocko.b-cdn.net" -ProbePath "/"
