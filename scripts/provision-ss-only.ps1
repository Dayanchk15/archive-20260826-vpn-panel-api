[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Server,
  [int]$SshPort = 22,
  [string]$SshUser = 'root',
  [string]$PasswordFile = 'C:\Users\Admin\password.txt',
  [string]$SshPassword = '',
  [int]$Port = 443,
  [string]$Version = '1.24.0',
  [string]$Method = '2022-blake3-aes-128-gcm',
  [string]$PanelHost = 'root@45.140.42.39',
  [string]$PanelSshKey = 'C:\Users\Admin\.ssh\id_ed25519',
  [switch]$SkipPanel,
  [switch]$RotateKey
)

$ErrorActionPreference = 'Stop'
$python = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\provision-shadowsocks-rust.py'
if (-not (Test-Path -LiteralPath $python)) { throw "SS installer not found: $python" }
$publishScript = Join-Path $PSScriptRoot 'publish-shared-ss-all-clients.mjs'
$publishPayload = Join-Path $env:TEMP "ss-publish-$([guid]::NewGuid().ToString('N')).json"
$remotePayload = '/opt/vpn-panel-api-vps/scripts/ss-publish.json'

try {
  if ($SshPassword) {
    $env:SS_SSH_PASSWORD = $SshPassword
  } elseif (Test-Path -LiteralPath $PasswordFile) {
    $env:SS_SSH_PASSWORD = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
  }

  $args = @($python, '--server', $Server, '--ssh-user', $SshUser,
    '--ssh-port', $SshPort, '--port', $Port, '--version', $Version, '--method', $Method)
  if ($RotateKey) { $args += '--rotate-key' }
  $ssOutput = (& python @args 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "SS installation failed:`n$ssOutput" }
  $ss = $ssOutput | ConvertFrom-Json
  if (-not $ss.link) { throw "SS installer returned no link:`n$ssOutput" }

  if (-not $SkipPanel) {
    if (-not (Test-Path -LiteralPath $PanelSshKey)) { throw "Panel SSH key not found: $PanelSshKey" }
    if (-not (Test-Path -LiteralPath $publishScript)) { throw "Panel publisher not found: $publishScript" }
    [IO.File]::WriteAllText($publishPayload, (@{ server=$Server; port=$Port; link=[string]$ss.link } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    & scp -q -i $PanelSshKey -o BatchMode=yes -o ConnectTimeout=20 $publishScript "$PanelHost`:/opt/vpn-panel-api-vps/scripts/publish-shared-ss-all-clients.mjs"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the panel SS publisher.' }
    & scp -q -i $PanelSshKey -o BatchMode=yes -o ConnectTimeout=20 $publishPayload "$PanelHost`:$remotePayload"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the SS publish payload.' }
    $remote = 'docker exec -e SS_PUBLISH_FILE=/app/scripts/ss-publish.json vpn-panel-api-vps node /app/scripts/publish-shared-ss-all-clients.mjs; rm -f /opt/vpn-panel-api-vps/scripts/ss-publish.json'
    & ssh -i $PanelSshKey -o BatchMode=yes -o ConnectTimeout=20 $PanelHost $remote
    if ($LASTEXITCODE -ne 0) { throw 'SS was installed, but panel synchronization failed.' }
  }

  $result = [ordered]@{ ok=$true; server=$ss.server; port=$ss.port; method=$ss.method; link=$ss.link; panelSynchronized=(-not $SkipPanel) }
  $result | ConvertTo-Json -Depth 5
} finally {
  Remove-Item Env:SS_SSH_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $publishPayload -Force -ErrorAction SilentlyContinue
}
