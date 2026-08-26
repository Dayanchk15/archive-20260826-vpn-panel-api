param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-verify-cf-list.ps1') @Args
exit $LASTEXITCODE
