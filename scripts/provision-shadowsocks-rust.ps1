[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Server,
  [int]$Port = 443,
  [int]$SshPort = 22,
  [string]$Version = '1.24.0',
  [switch]$RotateKey
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'provision-shadowsocks-rust.py'
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3 is required. Install Python and retry.' }

$args = @($script, '--server', $Server, '--port', $Port, '--ssh-port', $SshPort, '--version', $Version)
if ($RotateKey) { $args += '--rotate-key' }
& $python.Source @args
exit $LASTEXITCODE
