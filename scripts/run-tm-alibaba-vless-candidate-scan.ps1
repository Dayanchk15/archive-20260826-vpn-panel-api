param(
  [string]$InputFile = 'C:\Users\Admin\Desktop\cdn-ip-scans\alibaba-esa\alibaba-starlink-top-diverse-for-tm.txt',
  [ValidateSet('fr1', 'fr2', 'fornex', 'tampa')]
  [string]$Target = 'fr1',
  [int]$Limit = 0
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$tester = Join-Path $scriptDir 'test-alibaba-candidate-e2e.ps1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputDir = Split-Path -Parent (Resolve-Path -LiteralPath $InputFile)
$outIps = Join-Path $outputDir "alibaba-vless-tm-qualified-$stamp.txt"
$outJsonl = Join-Path $outputDir "alibaba-vless-tm-qualified-$stamp.jsonl"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator.'
}

$modem = Get-NetIPConfiguration |
  Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and
    $_.NetAdapter.InterfaceDescription -match 'Remote NDIS|RNDIS|USB.*(Ethernet|Internet)|Mobile|Apple Mobile' -and
    $_.IPv4Address -and $_.IPv4DefaultGateway
  } | Select-Object -First 1
if (-not $modem) { throw 'Active USB modem with IPv4 and gateway was not found.' }

$modemIp = $modem.IPv4Address[0].IPAddress
$gateway = $modem.IPv4DefaultGateway.NextHop
$ifIndex = $modem.InterfaceIndex
$candidates = Get-Content -LiteralPath $InputFile |
  ForEach-Object { if ($_ -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\b') { $Matches[1] } } |
  Where-Object { $_ } | Select-Object -Unique
if ($Limit -gt 0) { $candidates = @($candidates | Select-Object -First $Limit) }
if (-not $candidates) { throw 'No candidates found.' }

$uuidCache = Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp\alibaba-test-uuid.dpapi'
$env:ALIBABA_TEST_UUID = ''
if (Test-Path -LiteralPath $uuidCache) {
  try {
    $protectedUuid = [IO.File]::ReadAllText($uuidCache).Trim()
    $secureUuid = ConvertTo-SecureString $protectedUuid
    $uuidPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUuid)
    try {
      $cachedUuid = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($uuidPointer)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($uuidPointer)
    }
    if ($cachedUuid -match '^[0-9a-fA-F-]{36}$') { $env:ALIBABA_TEST_UUID = $cachedUuid }
  } catch {
    $env:ALIBABA_TEST_UUID = ''
  }
}

$uuidSources = @(
  @{ host = '130.17.12.61'; config = '/opt/vpn-fornex-alibaba-ws/config.json' },
  @{ host = '185.209.230.46'; config = '/opt/vpn-fr2-alibaba-ws/config.json' },
  @{ host = '185.209.230.14'; config = '/opt/vpn-fr1-alibaba-ws/config.json' },
  @{ host = '74.115.172.101'; config = '/opt/vpn-tampa-alibaba-ws/config.json' }
)
foreach ($source in $uuidSources) {
  if ($env:ALIBABA_TEST_UUID -match '^[0-9a-fA-F-]{36}$') { break }
  $remotePython = "import json;d=json.load(open('$($source.config)'));print(next(c['id'] for i in d['inbounds'] if i.get('protocol')=='vless' for c in i['settings']['clients']))"
  $remotePythonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remotePython))
  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $uuidRaw = & ssh -i 'C:\Users\Admin\.ssh\id_ed25519' -o BatchMode=yes -o ConnectTimeout=8 "root@$($source.host)" "echo $remotePythonBase64 | base64 -d | python3" 2>$null
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $candidateUuid = if ($null -eq $uuidRaw) { '' } else { ([string]$uuidRaw).Trim() }
    if ($candidateUuid -match '^[0-9a-fA-F-]{36}$') {
      $env:ALIBABA_TEST_UUID = $candidateUuid
      break
    }
    Start-Sleep -Seconds 1
  }
  if ($env:ALIBABA_TEST_UUID -match '^[0-9a-fA-F-]{36}$') { break }
}
if ($env:ALIBABA_TEST_UUID -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Could not load test UUID.' }
if (-not (Test-Path -LiteralPath $uuidCache)) {
  $secureUuid = ConvertTo-SecureString $env:ALIBABA_TEST_UUID -AsPlainText -Force
  $protectedUuid = ConvertFrom-SecureString $secureUuid
  [IO.File]::WriteAllText($uuidCache, $protectedUuid, [Text.UTF8Encoding]::new($false))
}

[IO.File]::WriteAllText($outIps, '', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($outJsonl, '', [Text.UTF8Encoding]::new($false))
$createdRoutes = [Collections.Generic.List[object]]::new()

try {
  $prefixes = $candidates | ForEach-Object { $p=$_.Split('.'); "$($p[0]).$($p[1]).0.0/16" } | Select-Object -Unique
  foreach ($prefix in $prefixes) {
    $existing = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
    if (-not $existing) {
      $route = New-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -InterfaceIndex $ifIndex -NextHop $gateway -RouteMetric 1 -PolicyStore ActiveStore
      $createdRoutes.Add($route)
    }
  }

  Write-Host "USB modem: $($modem.InterfaceAlias) $modemIp"
  Write-Host "Candidates: $($candidates.Count), target: $Target"
  Write-Host "Qualified IPs are written immediately to: $outIps"

  $number = 0
  foreach ($candidate in $candidates) {
    $number += 1
    $results = @(& $tester -CandidateIp $candidate -LocalAddress $modemIp -Target $Target -ReturnResult)
    $ok = $results.Count -gt 0 -and ($results | Where-Object { -not $_.ok }).Count -eq 0
    $record = [ordered]@{ testedAt=(Get-Date).ToUniversalTime().ToString('o'); ip=$candidate; ok=$ok; target=$Target; results=$results }
    [IO.File]::AppendAllText($outJsonl, (($record | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    if ($ok) {
      [IO.File]::AppendAllText($outIps, "$candidate`n", [Text.UTF8Encoding]::new($false))
      Write-Host "[FOUND] $candidate ($number/$($candidates.Count))"
    } else {
      Write-Host "[fail] $candidate ($number/$($candidates.Count))"
    }
  }
} finally {
  Remove-Item Env:ALIBABA_TEST_UUID -ErrorAction SilentlyContinue
  foreach ($route in $createdRoutes) { $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue }
  Write-Host "Results: $outIps"
}
