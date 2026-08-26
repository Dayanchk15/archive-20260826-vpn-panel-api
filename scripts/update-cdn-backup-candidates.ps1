param(
  [string]$OutputRoot = 'C:\Users\Admin\Desktop\cdn-ip-scans\reserve-cdn',
  [int]$SamplesPerPrefix = 12,
  [int]$MaxCandidatesPerProvider = 12000,
  [string]$TencentAsns = 'AS139341,AS132203',
  [string]$AlibabaAsns = 'AS24429',
  [string]$CloudflareHosts = 'fr1.levospeed.online,fr2.levospeed.online,fornex.levospeed.online,tampa.levospeed.online',
  [string]$TencentHosts = 'daykoo-tencent-fr1.levospeed.click,daykoo-tencent-fr2.levospeed.click,daykoo-tencent-fornex.levospeed.click,daykoo-tencent-tampa.levospeed.click',
  [string]$AlibabaHosts = 'cdn-a1.levospeed.click,cdn-a2.levospeed.click,cdn-a3.levospeed.click,cdn-a4.levospeed.click'
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $OutputRoot "runs\$stamp"
$currentDirectory = Join-Path $OutputRoot 'current'
New-Item -ItemType Directory -Force -Path $runDirectory,$currentDirectory | Out-Null

function ConvertTo-Ipv4Number([string]$Ip) {
  $parts = @($Ip.Split('.') | ForEach-Object { [uint64]$_ })
  if ($parts.Count -ne 4 -or @($parts | Where-Object { $_ -gt 255 }).Count -gt 0) {
    throw "Invalid IPv4 address: $Ip"
  }
  return (($parts[0] * 16777216) + ($parts[1] * 65536) + ($parts[2] * 256) + $parts[3])
}

function ConvertFrom-Ipv4Number([uint64]$Value) {
  return '{0}.{1}.{2}.{3}' -f (
    [math]::Floor($Value / 16777216) % 256
  ),(
    [math]::Floor($Value / 65536) % 256
  ),(
    [math]::Floor($Value / 256) % 256
  ),($Value % 256)
}

function Get-RipePrefixes([string[]]$Asns) {
  $result = [Collections.Generic.List[string]]::new()
  foreach ($asn in $Asns) {
    $url = "https://stat.ripe.net/data/announced-prefixes/data.json?resource=$asn"
    Write-Host "Fetching $asn prefixes from RIPEstat..."
    $response = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 45
    foreach ($row in @($response.data.prefixes)) {
      $prefix = [string]$row.prefix
      if ($prefix -match '^\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}$') { $result.Add($prefix) }
    }
  }
  return @($result | Sort-Object -Unique)
}

function Get-DnsIpv4([string[]]$Hosts) {
  $result = [Collections.Generic.List[string]]::new()
  foreach ($hostName in $Hosts) {
    try {
      foreach ($row in @(Resolve-DnsName -Name $hostName -Type A -DnsOnly -ErrorAction Stop)) {
        if ($row.IPAddress -match '^\d{1,3}(?:\.\d{1,3}){3}$') { $result.Add([string]$row.IPAddress) }
      }
    } catch {
      Write-Warning "DNS lookup failed for $hostName`: $($_.Exception.Message)"
    }
  }
  return @($result | Select-Object -Unique)
}

function Get-PrefixSamples([string[]]$Prefixes, [int]$Count) {
  $preferred = @(1,2,4,8,16,31,42,61,76,100,106,111,128,133,160,189,194,220,240,250)
  $result = [Collections.Generic.List[string]]::new()
  foreach ($prefix in $Prefixes) {
    $networkText,$lengthText = $prefix.Split('/')
    $length = [int]$lengthText
    if ($length -lt 8 -or $length -gt 31) { continue }
    $size = [uint64][math]::Pow(2, 32 - $length)
    $base = [uint64](ConvertTo-Ipv4Number $networkText)
    $base -= ($base % $size)
    $maxOffset = if ($size -gt 2) { $size - 2 } else { [uint64]0 }
    $offsets = [Collections.Generic.HashSet[uint64]]::new()
    foreach ($wanted in $preferred) {
      if ($offsets.Count -ge $Count) { break }
      [void]$offsets.Add([uint64][math]::Min([uint64]$wanted,$maxOffset))
    }
    for ($index = 1; $offsets.Count -lt $Count -and $index -le ($Count * 2); $index += 1) {
      $offset = [uint64][math]::Floor(($maxOffset * $index) / ($Count + 1))
      [void]$offsets.Add($offset)
    }
    foreach ($offset in $offsets) { $result.Add((ConvertFrom-Ipv4Number ($base + $offset))) }
  }
  return @($result | Select-Object -Unique)
}

function Select-Diverse([string[]]$Values, [string[]]$Pinned, [int]$Maximum) {
  $unique = @($Values | Where-Object { $_ } | Select-Object -Unique)
  if ($unique.Count -le $Maximum) { return $unique }
  $selected = [Collections.Generic.List[string]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($ip in $Pinned) {
    if ($ip -and $seen.Add($ip)) { $selected.Add($ip) }
  }
  $slots = [math]::Max(0, $Maximum - $selected.Count)
  for ($index = 0; $index -lt $slots; $index += 1) {
    $sourceIndex = [math]::Min($unique.Count - 1, [math]::Floor(($index * $unique.Count) / [math]::Max(1,$slots)))
    $ip = $unique[$sourceIndex]
    if ($seen.Add($ip)) { $selected.Add($ip) }
  }
  if ($selected.Count -lt $Maximum) {
    foreach ($ip in $unique) {
      if ($selected.Count -ge $Maximum) { break }
      if ($seen.Add($ip)) { $selected.Add($ip) }
    }
  }
  return @($selected)
}

function Save-Provider(
  [string]$Provider,
  [string[]]$Prefixes,
  [string[]]$DnsIps,
  [string[]]$Candidates,
  [hashtable]$Source
) {
  $selected = @(Select-Diverse -Values @($DnsIps + $Candidates) -Pinned $DnsIps -Maximum $MaxCandidatesPerProvider)
  $runCandidates = Join-Path $runDirectory "$Provider-candidates.txt"
  $runPrefixes = Join-Path $runDirectory "$Provider-prefixes.txt"
  [IO.File]::WriteAllText($runCandidates,'',$utf8)
  foreach ($ip in $selected) {
    [IO.File]::AppendAllText($runCandidates,"$ip`r`n",$utf8)
  }
  [IO.File]::WriteAllLines($runPrefixes,@($Prefixes),$utf8)
  Copy-Item -LiteralPath $runCandidates -Destination (Join-Path $currentDirectory "$Provider-candidates.txt") -Force
  Copy-Item -LiteralPath $runPrefixes -Destination (Join-Path $currentDirectory "$Provider-prefixes.txt") -Force
  return [ordered]@{ provider=$Provider; prefixCount=$Prefixes.Count; dnsIps=@($DnsIps); candidateCount=$selected.Count; source=$Source }
}

$cloudflarePrefixUrl = 'https://www.cloudflare.com/ips-v4/'
Write-Host 'Fetching Cloudflare IPv4 ranges...'
$cloudflarePrefixes = @((Invoke-WebRequest -UseBasicParsing -Uri $cloudflarePrefixUrl -TimeoutSec 45).Content -split '\s+' | Where-Object { $_ -match '/' })
$cloudflareDns = @(Get-DnsIpv4 ($CloudflareHosts -split '[,\s]+' | Where-Object { $_ }))
$cloudflare = Save-Provider 'cloudflare' $cloudflarePrefixes $cloudflareDns (Get-PrefixSamples $cloudflarePrefixes $SamplesPerPrefix) @{ url=$cloudflarePrefixUrl; type='official-ip-list' }

$tencentAsnList = @($TencentAsns -split '[,\s]+' | Where-Object { $_ -match '^AS\d+$' })
$tencentPrefixes = @(Get-RipePrefixes $tencentAsnList)
$tencentDns = @(Get-DnsIpv4 ($TencentHosts -split '[,\s]+' | Where-Object { $_ }))
$tencent = Save-Provider 'tencent' $tencentPrefixes $tencentDns (Get-PrefixSamples $tencentPrefixes $SamplesPerPrefix) @{ url='https://stat.ripe.net/'; type='announced-prefixes'; asns=$tencentAsnList }

$alibabaAsnList = @($AlibabaAsns -split '[,\s]+' | Where-Object { $_ -match '^AS\d+$' })
$alibabaPrefixes = @(Get-RipePrefixes $alibabaAsnList)
$alibabaDns = @(Get-DnsIpv4 ($AlibabaHosts -split '[,\s]+' | Where-Object { $_ }))
$alibaba = Save-Provider 'alibaba' $alibabaPrefixes $alibabaDns (Get-PrefixSamples $alibabaPrefixes $SamplesPerPrefix) @{ url='https://stat.ripe.net/'; type='announced-prefixes'; asns=$alibabaAsnList }

$manifest = [ordered]@{
  generatedAt=(Get-Date).ToUniversalTime().ToString('o')
  runDirectory=$runDirectory
  currentDirectory=$currentDirectory
  samplesPerPrefix=$SamplesPerPrefix
  maximumCandidatesPerProvider=$MaxCandidatesPerProvider
  providers=@($cloudflare,$tencent,$alibaba)
}
[IO.File]::WriteAllText((Join-Path $runDirectory 'manifest.json'),($manifest | ConvertTo-Json -Depth 8),$utf8)
[IO.File]::WriteAllText((Join-Path $OutputRoot 'latest-run.txt'),"$runDirectory`r`n",$utf8)
Copy-Item -LiteralPath (Join-Path $runDirectory 'manifest.json') -Destination (Join-Path $currentDirectory 'manifest.json') -Force

Write-Host ''
Write-Host 'Candidate update complete.'
Write-Host "Current lists: $currentDirectory"
$manifest.providers | ForEach-Object { Write-Host ("{0}: {1} prefixes, {2} candidates" -f $_.provider,$_.prefixCount,$_.candidateCount) }
