param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateIp,
  [string]$OriginHost = '130.17.12.61',
  [string]$SshKey = 'C:\Users\Admin\.ssh\id_ed25519',
  [string]$LocalAddress = '',
  [ValidateSet('all', 'fr1', 'fr2', 'fornex', 'tampa')]
  [string]$Target = 'all',
  [switch]$ReturnResult
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$xrayDir = Join-Path $repo 'tmp\xray-win'
$xray = Join-Path $xrayDir 'xray.exe'
$configPath = Join-Path $xrayDir 'ali-e2e-test.json'
$stdoutPath = Join-Path $xrayDir 'ali-e2e-out.log'
$stderrPath = Join-Path $xrayDir 'ali-e2e-err.log'

if (-not (Test-Path -LiteralPath $xray)) {
  throw "Xray not found: $xray"
}
if ($CandidateIp -notmatch '^(?:\d{1,3}\.){3}\d{1,3}$') {
  throw 'CandidateIp must be an IPv4 address.'
}

$uuid = [string]$env:ALIBABA_TEST_UUID
if ($uuid -notmatch '^[0-9a-fA-F-]{36}$') {
  $uuidSources = @(
    @{ host = $OriginHost; config = '/opt/vpn-fornex-alibaba-ws/config.json' },
    @{ host = '185.209.230.46'; config = '/opt/vpn-fr2-alibaba-ws/config.json' },
    @{ host = '185.209.230.14'; config = '/opt/vpn-fr1-alibaba-ws/config.json' },
    @{ host = '74.115.172.101'; config = '/opt/vpn-tampa-alibaba-ws/config.json' }
  )
  foreach ($source in $uuidSources) {
    $remotePython = "import json;d=json.load(open('$($source.config)'));print(next(c['id'] for i in d['inbounds'] if i.get('protocol')=='vless' for c in i['settings']['clients']))"
    $remotePythonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remotePython))
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $uuidRaw = & ssh -i $SshKey -o BatchMode=yes -o ConnectTimeout=8 "root@$($source.host)" "echo $remotePythonBase64 | base64 -d | python3" 2>$null
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $uuid = if ($null -eq $uuidRaw) { '' } else { ([string]$uuidRaw).Trim() }
    if ($uuid -match '^[0-9a-fA-F-]{36}$') { break }
  }
}
if ($uuid -notmatch '^[0-9a-fA-F-]{36}$') {
  throw 'Could not read a test UUID from the Fornex origin.'
}

$allEdgeProfiles = @(
  @{ id = 'fr1'; host = 'cdn-a1.levospeed.click' },
  @{ id = 'fr2'; host = 'cdn-a2.levospeed.click' },
  @{ id = 'fornex'; host = 'cdn-a3.levospeed.click' },
  @{ id = 'tampa'; host = 'cdn-a4.levospeed.click' }
)
if ($Target -eq 'all') {
  $edgeProfiles = $allEdgeProfiles
} else {
  $edgeProfiles = @($allEdgeProfiles | Where-Object { $_.id -eq $Target })
}
$inbounds = @()
$outbounds = @()
$rules = @()
for ($index = 0; $index -lt $edgeProfiles.Count; $index += 1) {
  $inboundTag = "socks$index"
  $outboundTag = "edge$index"
  $inbounds += @{
    listen = '127.0.0.1'
    port = 11901 + $index
    protocol = 'socks'
    tag = $inboundTag
    settings = @{ udp = $false }
  }
  $outbound = @{
    protocol = 'vless'
    tag = $outboundTag
    settings = @{
      vnext = @(@{
        address = $CandidateIp
        port = 443
        users = @(@{ id = $uuid; encryption = 'none' })
      })
    }
    streamSettings = @{
      network = 'ws'
      security = 'tls'
      tlsSettings = @{
        serverName = 'www.alibaba.com'
        allowInsecure = $false
        fingerprint = 'chrome'
        alpn = @('http/1.1')
      }
      wsSettings = @{ path = '/'; headers = @{ Host = $edgeProfiles[$index].host } }
    }
  }
  if ($LocalAddress) { $outbound.sendThrough = $LocalAddress }
  $outbounds += $outbound
  $rules += @{ type = 'field'; inboundTag = @($inboundTag); outboundTag = $outboundTag }
}

$config = @{
  log = @{ loglevel = 'warning' }
  inbounds = $inbounds
  outbounds = $outbounds
  routing = @{ domainStrategy = 'AsIs'; rules = $rules }
}

$process = $null
try {
  $configJson = $config | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($configPath, $configJson, [Text.UTF8Encoding]::new($false))
  $configTest = & $xray run -test -config $configPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Generated Xray client config is invalid: $($configTest -join ' ')"
  }
  $process = Start-Process -FilePath $xray -ArgumentList @('run', '-config', $configPath) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Start-Sleep -Seconds 2

  $failed = $false
  for ($index = 0; $index -lt $edgeProfiles.Count; $index += 1) {
    $port = 11901 + $index
    $probe = & curl.exe -sS --max-time 20 --socks5-hostname "127.0.0.1:$port" `
      -o NUL -w 'http=%{http_code} total=%{time_total}' https://www.google.com/generate_204
    $ok = $LASTEXITCODE -eq 0 -and $probe -match '^http=204 '
    if (-not $ok) { $failed = $true }
    [pscustomobject]@{ target = $edgeProfiles[$index].id; host = $edgeProfiles[$index].host; candidate = $CandidateIp; ok = $ok; result = $probe }
  }
  if ($failed -and -not $ReturnResult) { exit 2 }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}
