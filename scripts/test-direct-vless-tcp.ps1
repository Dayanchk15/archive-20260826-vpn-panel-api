param(
  [Parameter(Mandatory = $true)][string]$Address,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Uuid
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$xrayDir = Join-Path $repo 'tmp\xray-win'
$xray = Join-Path $xrayDir 'xray.exe'
$configPath = Join-Path $xrayDir 'direct-vless-tcp-test.json'
$stdoutPath = Join-Path $xrayDir 'direct-vless-tcp-test.out.log'
$stderrPath = Join-Path $xrayDir 'direct-vless-tcp-test.err.log'
$process = $null

if ($Uuid -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Invalid UUID.' }
try {
  $config = @{
    log = @{ loglevel = 'warning' }
    inbounds = @(@{
      listen = '127.0.0.1'; port = 11911; protocol = 'socks'; tag = 'socks-test'; settings = @{ udp = $false }
    })
    outbounds = @(@{
      protocol = 'vless'; tag = 'direct-vless';
      settings = @{ vnext = @(@{ address = $Address; port = $Port; users = @(@{ id = $Uuid; encryption = 'none' }) }) }
      streamSettings = @{ network = 'tcp'; security = 'none'; tcpSettings = @{ header = @{ type = 'none' } } }
    })
  }
  $json = $config | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))
  $check = & $xray run -test -config $configPath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Invalid Xray config: $($check -join ' ')" }
  $process = Start-Process -FilePath $xray -ArgumentList @('run', '-config', $configPath) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Start-Sleep -Seconds 2
  $probe = & curl.exe -sS --max-time 25 --socks5-hostname 127.0.0.1:11911 `
    -o NUL -w 'http=%{http_code} total=%{time_total}' https://www.google.com/generate_204
  [pscustomobject]@{ address = $Address; port = $Port; ok = ($LASTEXITCODE -eq 0 -and $probe -match '^http=204 '); result = $probe }
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}
