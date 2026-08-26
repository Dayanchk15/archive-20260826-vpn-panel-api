param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-cdn-ip-scan.ps1') @Args
exit $LASTEXITCODE
