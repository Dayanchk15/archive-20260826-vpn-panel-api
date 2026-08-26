[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Server,
  [int]$SshPort = 22,
  [string]$SshUser = 'root',
  [string]$PasswordFile = 'C:\Users\Admin\password.txt',
  [string]$SshPassword = '',
  [string]$EgressConfig = '',
  [string]$Fr1 = '185.209.230.14',
  [int]$Fr1SshPort = 22,
  [string]$Fr1SshKey = 'C:\Users\Admin\.ssh\id_ed25519',
  [string]$Fr1SshPassword = '',
  [string[]]$RetireServer = @(),
  [int]$SsPortBase = 20002,
  [int]$VlessPortBase = 21000,
  [switch]$SkipPanel,
  [switch]$SkipFr1Sync
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$panelHost = 'root@45.140.42.39'
$EgressConfig = if ($EgressConfig) { $EgressConfig } else { Join-Path $root 'config\new-vps-egresses.json' }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$tmp = Join-Path $root "tmp-vps-bundle-$stamp"
$clientsFile = Join-Path $tmp 'clients.json'
$mapFile = Join-Path $tmp 'links.json'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Run-Checked([string]$File, [string[]]$Arguments) {
  $id = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $env:TEMP "vps-bundle-$id.out"
  $stderrPath = Join-Path $env:TEMP "vps-bundle-$id.err"
  try {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    $combined = @($stdout, $stderr) -join "`n"
    if ($process.ExitCode -ne 0) { throw "Command failed: $File $($Arguments -join ' ')`n$combined" }
    return $combined.TrimEnd()
  } finally {
    Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  if (-not (Test-Path -LiteralPath $EgressConfig)) { throw "Egress config not found: $EgressConfig" }
  if ($SshPassword) {
    $plain = $SshPassword
  } else {
    if (-not (Test-Path -LiteralPath $PasswordFile)) { throw "Password file not found: $PasswordFile" }
    $plain = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
  }
  if (-not $plain) { throw 'Password file is empty.' }
  $env:SS_SSH_PASSWORD = $plain
  if ($Fr1SshPassword) { $env:FR1_SSH_PASSWORD = $Fr1SshPassword }

  $reportKey = ''
  if (-not $SkipPanel) {
    Write-Host '1/5 Reading the panel report key and active clients...'
    $sshArgs = @('-o','BatchMode=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2')
    $reportKey = ((& ssh @sshArgs $panelHost "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps | head -1 | cut -d= -f2-" 2>$null) -join '').Trim()
    if (-not $reportKey) { throw 'Could not read EDGE_REPORT_KEY from the panel host.' }
    Run-Checked 'scp' @('-q','-o','ConnectTimeout=20', (Join-Path $PSScriptRoot 'export-vless-relay-clients.mjs'), "$panelHost`:/opt/vpn-panel-api-vps/scripts/export-vps-bundle-clients.mjs") | Out-Null
    $json = ((& ssh @sshArgs $panelHost "timeout 90s docker exec vpn-panel-api-vps node /app/scripts/export-vps-bundle-clients.mjs") -join "`n")
    if (-not $json.TrimStart().StartsWith('[')) { throw "Panel client export returned unexpected data: $json" }
    [IO.File]::WriteAllText($clientsFile, $json, [Text.UTF8Encoding]::new($false))
    Write-Host '   Active client export completed.'
  } else {
    throw '-SkipPanel requires a local clients file; run the Python installer directly.'
  }

  if (-not $SkipFr1Sync) {
    Write-Host '2/6 Synchronizing active UUIDs into the dedicated FR1 relay...'
    $syncArgs = @((Join-Path $PSScriptRoot 'sync-fr1-vless-clients.py'), '--fr1', $Fr1,
      '--ssh-port', $Fr1SshPort, '--clients-file', $clientsFile, '--ssh-key', $Fr1SshKey)
    Run-Checked 'python' $syncArgs | Write-Host
  }

  Write-Host '3/6 Installing isolated per-user SS and VLESS multi-egress Xray...'
  $provisionArgs = @((Join-Path $PSScriptRoot 'provision-vps-bundle-all.py'), '--server', $Server, '--ssh-port', $SshPort, '--ssh-user', $SshUser, '--clients-file', $clientsFile, '--egress-config', $EgressConfig, '--map-out', $mapFile, '--report-key', $reportKey, '--ss-port-base', $SsPortBase, '--vless-port-base', $VlessPortBase)
  foreach ($retired in $RetireServer) { if ($retired) { $provisionArgs += @('--retire-server', $retired) } }
  $summary = Run-Checked 'python' $provisionArgs
  Write-Host $summary

  Write-Host '4/6 Installing the traffic reporter (Xray Stats API only)...'
  Run-Checked 'python' @((Join-Path $PSScriptRoot 'install-vps-bundle-reporter.py'), '--server', $Server, '--ssh-port', $SshPort, '--node-id', ("vps-bundle-" + ($Server -replace '\.','')), '--api-port', 10105, '--report-key', $reportKey) | Write-Host

  Write-Host '5/6 Registering per-user links in the panel...'
  Run-Checked 'scp' @('-q','-o','ConnectTimeout=20', $mapFile, "$panelHost`:/opt/vpn-panel-api-vps/scripts/vps-bundle-links.json") | Out-Null
  Run-Checked 'scp' @('-q','-o','ConnectTimeout=20', (Join-Path $PSScriptRoot 'register-vps-bundle-links.mjs'), "$panelHost`:/opt/vpn-panel-api-vps/scripts/register-vps-bundle-links.mjs") | Out-Null
  $retiredEnv = ($RetireServer | Where-Object { $_ }) -join ','
  $remote = if ($retiredEnv) { "docker exec -e RETIRE_SERVER_IPS=`"$retiredEnv`" vpn-panel-api-vps node /app/scripts/register-vps-bundle-links.mjs" } else { 'docker exec vpn-panel-api-vps node /app/scripts/register-vps-bundle-links.mjs' }
  Run-Checked 'ssh' @('-o','BatchMode=yes','-o','ConnectTimeout=20',$panelHost,$remote) | Write-Host

  Write-Host '6/6 Completed. Existing services were not restarted; only the dedicated FR1 relay was reloaded if UUIDs changed.'
  [pscustomobject]@{ ok=$true; server=$Server; ss='per-user ports'; vless='4 egress ports'; trafficReporter=$true; panelSynchronized=$true } | ConvertTo-Json
}
finally {
  Remove-Item Env:SS_SSH_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:FR1_SSH_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
