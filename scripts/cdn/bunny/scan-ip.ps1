param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-bunny-ip-scan.ps1') @Args
exit $LASTEXITCODE
