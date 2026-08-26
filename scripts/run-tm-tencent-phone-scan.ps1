param(
  [int]$Limit = 800,
  [int]$Concurrency = 5,
  [int]$TimeoutMs = 6000,
  [int]$Top = 30
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Important: do not force an old Wi-Fi/local IP. Let tm-cdn-ip-scan auto-detect
# iPhone/Android USB tethering, or use Windows default route if the phone is the
# only active internet connection.
Remove-Item Env:\LOCAL_ADDRESS -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path (Join-Path $repo "tmp") | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "tmp\tm-tencent-phone-$stamp.json"
$topOut = Join-Path $repo "tmp\tencent-edgeone-phone-top-ips.txt"

Write-Host ""
Write-Host "=== Active default routes ==="
Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric |
  Select-Object -First 8 InterfaceAlias,NextHop,RouteMetric,InterfaceMetric |
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== Active IPv4 interfaces ==="
Get-NetIPConfiguration |
  Where-Object { $_.IPv4DefaultGateway -or $_.NetAdapter.Status -eq "Up" } |
  Select-Object InterfaceAlias,InterfaceDescription,
    @{n='IPv4';e={$_.IPv4Address.IPAddress -join ','}},
    @{n='Gateway';e={$_.IPv4DefaultGateway.NextHop -join ','}} |
  Format-Table -AutoSize

Write-Host ""
Write-Host "Starting Tencent EdgeOne scan..."
Write-Host "Report: $out"
Write-Host ""

node .\scripts\tm-cdn-ip-scan.mjs `
  --provider=tencent `
  --limit=$Limit `
  --concurrency=$Concurrency `
  --timeout=$TimeoutMs `
  --top=$Top `
  --out=$out `
  --tencent-sni=www.tencentwm.com `
  --tencent-host=daykoo-tencent-fr1.levospeed.click `
  --tencent-path=/eo/v1/4bfa6f260da5

Write-Host ""
Write-Host "=== Best ws=101 IPs ==="

node -e "const fs=require('fs'); const file=process.argv[1]; const topOut=process.argv[2]; const r=JSON.parse(fs.readFileSync(file,'utf8')); const rows=(r.tencent&&r.tencent.rows||[]).filter(x=>x.ok&&x.wsStatus===101).slice(0,50); fs.writeFileSync(topOut, rows.map(x=>x.ip).join('\n')+(rows.length?'\n':'')); console.log(JSON.stringify({report:file, publicIp:r.publicIp, localAddress:r.localAddress, okCount:rows.length, top:rows.slice(0,20).map(x=>({ip:x.ip,tcpMs:x.tcpMs,tlsMs:x.tlsMs,wsStatus:x.wsStatus}))}, null, 2)); if(!rows.length) process.exit(2);" $out $topOut

Write-Host ""
Write-Host "Saved top IP list: $topOut"
