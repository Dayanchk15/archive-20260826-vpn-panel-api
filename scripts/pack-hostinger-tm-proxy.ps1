# Pack Hostinger TM proxy files for upload to public_html/sub/
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "hostinger-tm-proxy.zip"
$files = @(
    (Join-Path $root "hostinger\index.php"),
    (Join-Path $root "hostinger\.htaccess"),
    (Join-Path $root "hostinger\config.php")
)
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path $files -DestinationPath $out -Force
Write-Host "Created: $out"
