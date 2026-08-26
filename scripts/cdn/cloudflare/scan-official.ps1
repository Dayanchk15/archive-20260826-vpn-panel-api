param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
& (Join-Path $PSScriptRoot '..\..\run-tm-cloudflare-official-scan.ps1') @Args
exit $LASTEXITCODE
