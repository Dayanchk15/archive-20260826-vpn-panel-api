[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Server,
  [int]$SshPort = 22,
  [string]$Fr1 = '185.209.230.14',
  [int]$SsPort = 443,
  [int]$VlessPort = 18443,
  [int]$Fr1Port = 18444,
  [int]$ApiPort = 10095,
  [int]$Fr1ApiPort = 11096,
  [string]$ServerId = '',
  [switch]$PublishSs,
  [switch]$SkipPanel
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$panelHost = 'root@45.140.42.39'
$serverId = if ($ServerId) { $ServerId } else { "vless-tcp-fr1-relay-$($Server -replace '[^0-9A-Za-z]', '')" }
$nodeId = $serverId
$clientsFile = Join-Path $root "tmp-vless-relay-clients-$([guid]::NewGuid().ToString('N')).json"

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  $out = & $File @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Command failed: $File $($Arguments -join ' ')`n$($out -join "`n")" }
  return ($out -join "`n")
}

$secure = Read-Host "SSH password for root@$Server (used only in memory)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
try {
  $env:SS_SSH_PASSWORD = $plain
  $env:VLESS_FR1_RELAY_SSH_PASSWORD = $plain
  $env:TRAFFIC_REPORTER_SSH_PASSWORD = $plain
  $env:VLESS_CLIENT_SYNC_SSH_PASSWORD = $plain

  Write-Host '1/7 Installing or preserving Shadowsocks on TCP/UDP 443...'
  $ssText = Invoke-Checked 'python' @((Join-Path $PSScriptRoot 'provision-shadowsocks-rust.py'), '--server', $Server, '--ssh-port', $SshPort, '--port', $SsPort)
  $ss = $ssText | ConvertFrom-Json

  Write-Host '2/7 Provisioning VLESS TCP ingress -> FR1...'
  $vlessText = Invoke-Checked 'python' @((Join-Path $PSScriptRoot 'provision-vless-tcp-fr1-relay.py'), '--server', $Server, '--ssh-port', $SshPort, '--fr1', $Fr1, '--listen-port', $VlessPort, '--fr1-port', $Fr1Port, '--api-port', $ApiPort, '--fr1-api-port', $Fr1ApiPort)
  $vless = $vlessText | ConvertFrom-Json

  if (-not $SkipPanel) {
    Write-Host '3/7 Reading the existing panel report key over the panel SSH key...'
    $reportKey = ((& ssh -o BatchMode=yes $panelHost "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps | head -1 | cut -d= -f2-" 2>$null) -join '').Trim()
    if (-not $reportKey) { throw 'Could not read EDGE_REPORT_KEY from the panel host.' }
    $env:EDGE_REPORT_KEY = $reportKey

    Write-Host '4/7 Exporting active client UUIDs from the panel...'
    Invoke-Checked 'scp' @('-q', (Join-Path $PSScriptRoot 'export-vless-relay-clients.mjs'), "$panelHost`:/opt/vpn-panel-api-vps/scripts/export-vless-relay-clients.mjs") | Out-Null
    $clientJson = ((& ssh -o BatchMode=yes $panelHost "docker exec vpn-panel-api-vps node /app/scripts/export-vless-relay-clients.mjs") -join "`n")
    [IO.File]::WriteAllText($clientsFile, $clientJson, [Text.UTF8Encoding]::new($false))

    Write-Host '5/7 Applying all active client UUIDs to the VLESS ingress...'
    Invoke-Checked 'python' @((Join-Path $PSScriptRoot 'sync-vless-relay-clients.py'), '--server', $Server, '--ssh-port', $SshPort, '--clients-file', $clientsFile, '--retain-uuid', $vless.uuid) | Out-Null

    Write-Host '6/7 Installing and starting the Xray traffic reporter...'
    Invoke-Checked 'python' @((Join-Path $PSScriptRoot 'install-vless-fr1-traffic-reporter.py'), '--server', $Server, '--ssh-port', $SshPort, '--api-port', $ApiPort, '--node-id', $nodeId) | Out-Null

    Write-Host '7/7 Registering the node and assigning it to every active client...'
    Invoke-Checked 'scp' @('-q', (Join-Path $PSScriptRoot 'add-vless-fr1-relay-all-clients.mjs'), "$panelHost`:/opt/vpn-panel-api-vps/scripts/add-vless-fr1-relay-all-clients.mjs") | Out-Null
    $dockerEnv = @("SERVER_ID=$serverId", "SERVER_HOST=$Server", "SERVER_PORT=$VlessPort", "SERVER_UUID=$($vless.uuid)", "TRAFFIC_NODE_ID=$nodeId")
    $envArgs = ($dockerEnv | ForEach-Object { "-e `"$_`"" }) -join ' '
    if ($PublishSs) { $remote = "docker exec -e `"SS_LINK=$($ss.link)`" $envArgs vpn-panel-api-vps node /app/scripts/add-vless-fr1-relay-all-clients.mjs --apply --publish-ss" }
    else { $remote = "docker exec $envArgs vpn-panel-api-vps node /app/scripts/add-vless-fr1-relay-all-clients.mjs --apply" }
    Invoke-Checked 'ssh' @('-o', 'BatchMode=yes', $panelHost, $remote) | Out-Null
  } else {
    Write-Host 'Panel registration/reporter steps skipped (-SkipPanel).'
  }

  [pscustomobject]@{
    ok = $true
    server = $Server
    ssLink = $ss.link
    vlessLink = $vless.link
    serverId = $serverId
    trafficReporter = (-not $SkipPanel)
    note = 'SS uses a shared key; per-user accounting is provided for the VLESS ingress UUIDs.'
  } | ConvertTo-Json -Depth 5
}
finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:SS_SSH_PASSWORD,Env:VLESS_FR1_RELAY_SSH_PASSWORD,Env:TRAFFIC_REPORTER_SSH_PASSWORD,Env:VLESS_CLIENT_SYNC_SSH_PASSWORD,Env:EDGE_REPORT_KEY -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $clientsFile -Force -ErrorAction SilentlyContinue
}
