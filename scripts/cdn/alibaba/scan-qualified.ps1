param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-alibaba-qualified-scan.ps1') @Args
exit $LASTEXITCODE
