param(
  [string[]]$Hosts = @('t1.tamdyrly.ru','for.akyol.online'),
  [string]$Path = '/s?ed=2048',
  [int]$Port = 443,
  [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Continue'
$results = foreach ($hostName in $Hosts) {
  $dnsMs = $tcpMs = $tlsMs = $wsMs = $null
  $dns = @()
  $errorText = $null
  try {
    $t = [Diagnostics.Stopwatch]::StartNew()
    $dns = @(Resolve-DnsName -Name $hostName -Type A -ErrorAction Stop |
      Where-Object { $_.IPAddress -match '^\d{1,3}(?:\.\d{1,3}){3}$' } |
      ForEach-Object IPAddress)
    $t.Stop(); $dnsMs = $t.ElapsedMilliseconds
    if (-not $dns.Count) { throw 'No A record' }

    $tcp = [Net.Sockets.TcpClient]::new()
    $t = [Diagnostics.Stopwatch]::StartNew()
    $async = $tcp.BeginConnect([string]$dns[0], $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      $tcp.Close(); throw 'TCP timeout'
    }
    $tcp.EndConnect($async)
    $t.Stop(); $tcpMs = $t.ElapsedMilliseconds

    $ssl = [Net.Security.SslStream]::new($tcp.GetStream(), $false, ({ $true }))
    $t = [Diagnostics.Stopwatch]::StartNew()
    $ssl.AuthenticateAsClient($hostName)
    $t.Stop(); $tlsMs = $t.ElapsedMilliseconds

    $keyBytes = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($keyBytes)
    $rng.Dispose()
    $wsKey = [Convert]::ToBase64String($keyBytes)
    $request = "GET $Path HTTP/1.1`r`nHost: $hostName`r`nConnection: Upgrade`r`nUpgrade: websocket`r`nSec-WebSocket-Key: $wsKey`r`nSec-WebSocket-Version: 13`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($request)
    $ssl.Write($bytes,0,$bytes.Length); $ssl.Flush()
    $buffer = New-Object byte[] 4096
    $t = [Diagnostics.Stopwatch]::StartNew()
    $read = $ssl.Read($buffer,0,$buffer.Length)
    $t.Stop(); $wsMs = $t.ElapsedMilliseconds
    $header = [Text.Encoding]::ASCII.GetString($buffer,0,$read)
    $status = ($header -split "`r?`n")[0]
    $ok = $status -match '^HTTP/1\.1 101\b'
    if (-not $ok) { $errorText = $status }
    $ssl.Dispose(); $tcp.Dispose()
  } catch { $errorText = $_.Exception.Message; try{$ssl.Dispose()}catch{};try{$tcp.Dispose()}catch{} }
  [pscustomobject]@{Host=$hostName;IPs=($dns -join ',');DNSms=$dnsMs;TCPms=$tcpMs;TLSms=$tlsMs;WSms=$wsMs;WS101=($errorText -eq $null);Error=$errorText}
}
$results | Format-Table -AutoSize
$results | ConvertTo-Json -Depth 3
