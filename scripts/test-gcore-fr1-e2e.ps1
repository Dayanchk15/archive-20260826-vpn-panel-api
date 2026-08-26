param(
  [string]$EdgeAddress = '81.28.12.12',
  [string]$Domain = 'gcore-fr1.levospeed.online',
  [string]$Path = '/gcore/fr1/7f34d9a28c61/ws'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$xrayDirectory = Join-Path $repo 'tmp\xray-win'
$xray = Join-Path $xrayDirectory 'xray.exe'
$serverConfig = Join-Path $repo 'tmp\fr1-gcore-ws-config.json'
$testConfig = Join-Path $xrayDirectory 'gcore-fr1-e2e-test.json'
$stdout = Join-Path $xrayDirectory 'gcore-fr1-e2e-out.log'
$stderr = Join-Path $xrayDirectory 'gcore-fr1-e2e-err.log'

if (-not (Test-Path -LiteralPath $xray)) { throw "Xray is missing: $xray" }
if (-not (Test-Path -LiteralPath $serverConfig)) {
  & scp -q -i 'C:\Users\Admin\.ssh\id_ed25519' `
    root@185.209.230.14:/opt/vpn-gcore-fr1-ws/config.json $serverConfig
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the FR1 Gcore config.' }
}

$source = Get-Content -Raw -LiteralPath $serverConfig | ConvertFrom-Json
$vlessInbound = $source.inbounds | Where-Object protocol -eq 'vless' | Select-Object -First 1
$uuid = [string]$vlessInbound.settings.clients[0].id
if ($uuid -notmatch '^[0-9a-fA-F-]{36}$') { throw 'A test client UUID was not found.' }

$config = @{
  log = @{ loglevel = 'warning' }
  inbounds = @(@{
    listen = '127.0.0.1'; port = 11955; protocol = 'socks'; tag = 'socks'
    settings = @{ udp = $false }
  })
  outbounds = @(@{
    protocol = 'vless'; tag = 'gcore'
    settings = @{ vnext = @(@{
      address = $EdgeAddress; port = 443
      users = @(@{ id = $uuid; encryption = 'none' })
    }) }
    streamSettings = @{
      network = 'ws'; security = 'tls'
      tlsSettings = @{
        serverName = $Domain; allowInsecure = $false
        fingerprint = 'chrome'; alpn = @('http/1.1')
      }
      wsSettings = @{ path = $Path; headers = @{ Host = $Domain } }
    }
  })
}

$process = $null
try {
  [IO.File]::WriteAllText(
    $testConfig,
    ($config | ConvertTo-Json -Depth 20),
    [Text.UTF8Encoding]::new($false)
  )
  $validation = & $xray run -test -config $testConfig 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Invalid Xray test config: $($validation -join ' ')" }

  $process = Start-Process -FilePath $xray -ArgumentList @('run','-config',$testConfig) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Start-Sleep -Seconds 2
  $probe = & curl.exe -sS --max-time 20 --socks5-hostname '127.0.0.1:11955' `
    -o NUL -w 'http=%{http_code} connect=%{time_connect} total=%{time_total} remote=%{remote_ip}' `
    https://www.google.com/generate_204
  $exitCode = $LASTEXITCODE
  [pscustomobject]@{
    ok = ($exitCode -eq 0 -and $probe -match '^http=204 ')
    edge = $EdgeAddress
    domain = $Domain
    result = $probe
    exitCode = $exitCode
  }
  if ($exitCode -ne 0) {
    Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
    exit $exitCode
  }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $testConfig -Force -ErrorAction SilentlyContinue
}
