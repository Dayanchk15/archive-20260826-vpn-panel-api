#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$taskName = 'Levospeed-Starlink2-VLESS'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName $taskName | Out-Null
}

$processes = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'xray.exe' -and $_.ExecutablePath -like "$repo\tmp\xray-win\*") -or
  ($_.Name -in @('node.exe', 'powershell.exe', 'pwsh.exe') -and $_.CommandLine -match
    'filter-alibaba-esa-candidates|run-tm-alibaba|test-alibaba-candidate|test-direct-vless-tcp')
}
foreach ($process in $processes) {
  if ($process.ProcessId -ne $PID) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$services = @('SEVPNCLIENT', 'SEVPNSERVER', 'UrbanVPN-Service')
foreach ($serviceName in $services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service) { continue }
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
  }
  Set-Service -Name $serviceName -StartupType Disabled
}

Write-Host '=== Cleanup result ==='
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
  Select-Object TaskName, State | Format-Table -AutoSize
Get-CimInstance Win32_Service | Where-Object { $_.Name -in $services } |
  Select-Object Name, State, StartMode, ProcessId | Format-Table -AutoSize
$remainingXray = Get-Process xray -ErrorAction SilentlyContinue
if ($remainingXray) {
  $remainingXray | Select-Object Id, Path, StartTime | Format-Table -AutoSize
} else {
  Write-Host 'Xray processes: none'
}
