[CmdletBinding()]
param(
  [string]$Server = '',
  [int]$SshPort = 22,
  [string]$SshUser = 'root',
  [int]$Port = 443,
  [string]$Method = '2022-blake3-aes-128-gcm',
  [string]$SshPassword = '',
  [switch]$RotateKey
)

$ErrorActionPreference = 'Stop'
if (-not $Server) { $Server = Read-Host 'IP или hostname сервера' }
$script = Join-Path $PSScriptRoot 'provision-xray-ss-only.py'
if (-not (Test-Path -LiteralPath $script)) { throw "Installer not found: $script" }

$args = @($script, '--server', $Server, '--ssh-port', $SshPort, '--ssh-user', $SshUser, '--port', $Port, '--method', $Method)
if ($SshPassword) { $env:SS_SSH_PASSWORD = $SshPassword }
if ($RotateKey) { $args += '--rotate-key' }
try {
  & python @args
  if ($LASTEXITCODE -ne 0) { throw "Xray Shadowsocks installer failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:SS_SSH_PASSWORD -ErrorAction SilentlyContinue
}
