param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-render-gentle-scan.ps1') @Args
exit $LASTEXITCODE
