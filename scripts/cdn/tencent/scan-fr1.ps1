param(
  [string]$InterfaceAlias = '',
  [string]$LocalAddress = '',
  [int]$Limit = 30000,
  [int]$Concurrency = 80,
  [int]$TimeoutMs = 3500,
  [int]$ApplicationLimit = 6000,
  [int]$Top = 100,
  [string]$CandidateFile = '',
  [switch]$RefreshCandidates
)
& (Join-Path $PSScriptRoot '..\..\run-tm-tencent-fr1-scan.ps1') `
  -InterfaceAlias $InterfaceAlias `
  -LocalAddress $LocalAddress `
  -Limit $Limit `
  -Concurrency $Concurrency `
  -TimeoutMs $TimeoutMs `
  -ApplicationLimit $ApplicationLimit `
  -Top $Top `
  -CandidateFile $CandidateFile `
  -RefreshCandidates:$RefreshCandidates
exit $LASTEXITCODE
