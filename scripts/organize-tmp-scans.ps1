param([switch]$Apply)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$tmp=Join-Path $repo 'tmp'
$root=Join-Path $tmp 'ip-scans'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$manifest=Join-Path $tmp "cleanup-manifest-$stamp.json"
$items=Get-ChildItem -LiteralPath $tmp -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{Path=$_.FullName;Type=if($_.PSIsContainer){'directory'}else{'file'};Length=if($_.PSIsContainer){$null}else{$_.Length};LastWrite=$_.LastWriteTimeUtc.ToString('o')}
}
$items | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $manifest -Encoding UTF8
if(-not $Apply){ Write-Host "Dry run only. Manifest: $manifest"; exit 0 }

foreach($name in @('alibaba','bunny','cloudflare','fastly','tencent','render','mixed')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $name) | Out-Null }
$rules=@(
  @{Name='alibaba';Pattern='^(alibaba|tm-alibaba)'},
  @{Name='bunny';Pattern='^(bunny|tm-bunny)'},
  @{Name='cloudflare';Pattern='^(cloudflare|cf-|tm-cloudflare)'},
  @{Name='fastly';Pattern='^(fastly|tm-fastly)'},
  @{Name='tencent';Pattern='^(tencent|tm-tencent|probe-.*tencent|final-.*tencent)'},
  @{Name='render';Pattern='^(render|tm-render)'},
  @{Name='mixed';Pattern='^(tm-cdn|tm-verify-cf|tm-cloudflare-alibaba|tm-verify|cf-render)'}
)
$moved=0
foreach($item in @(Get-ChildItem -LiteralPath $tmp -Force)) {
  if($item.Name -eq 'ip-scans' -or $item.Name -like 'cleanup-manifest-*'){continue}
  $rule=$rules | Where-Object {$item.Name -match $_.Pattern} | Select-Object -First 1
  if($rule){
    try { Move-Item -LiteralPath $item.FullName -Destination (Join-Path $root $rule.Name) -Force -ErrorAction Stop; $moved++ }
    catch { Write-Warning "Skipped locked item: $($item.FullName)" }
  }
}
$zero=@(Get-ChildItem -LiteralPath $tmp -File -Recurse -ErrorAction SilentlyContinue | Where-Object Length -eq 0)
foreach($file in $zero){
  try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop }
  catch { Write-Warning "Skipped locked zero-byte file: $($file.FullName)" }
}
$empty=@(Get-ChildItem -LiteralPath $tmp -Directory -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Where-Object {-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)})
foreach($dir in $empty){
  try { Remove-Item -LiteralPath $dir.FullName -Force -ErrorAction Stop }
  catch { Write-Warning "Skipped locked directory: $($dir.FullName)" }
}
Write-Host "Moved=$moved; zero-byte files removed=$($zero.Count); empty directories removed=$($empty.Count)"
Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {[pscustomobject]@{CDN=$_.Name;Files=@(Get-ChildItem -LiteralPath $_.FullName -File -Recurse).Count}} | Format-Table -AutoSize
