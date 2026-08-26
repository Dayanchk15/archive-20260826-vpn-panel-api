$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$stamp = '20260826'
$stageRoot = Join-Path 'C:\Users\Admin' ("migration-archive-$stamp-" + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null

$projects = @(
  @{ Name = 'vpn-panel-api'; Src = 'C:\Users\Admin\vpn-panel-api' },
  @{ Name = 'hiddify-dada-android'; Src = 'C:\Users\Admin\vpn-panel-api\hiddify-dada-android' },
  @{ Name = 'boton-github'; Src = 'C:\Users\Admin\Boton-github' },
  @{ Name = 'boton-deploy-staging'; Src = 'C:\Users\Admin\Boton-deploy-staging\Boton-master' },
  @{ Name = 'danatar-help'; Src = 'C:\Users\Admin\danatar.help' },
  @{ Name = 'delivery-tm'; Src = 'C:\Users\Admin\delivery_tm' },
  @{ Name = 'email-builder-team-ready'; Src = 'C:\Users\Admin\email-builder-web-team-ready' },
  @{ Name = 'palate-test-project'; Src = 'C:\Users\Admin\Palate test project' },
  @{ Name = 'telegram-bot-mosaic'; Src = 'C:\Users\Admin\telegram_bot_mosaic' },
  @{ Name = 'vpn-keenetic'; Src = 'C:\Users\Admin\vpn-keenetic' },
  @{ Name = 'currency-project'; Src = 'C:\Users\Admin\currency-project' },
  @{ Name = 'kasino'; Src = 'C:\Users\Admin\Desktop\kasino' },
  @{ Name = 'danatar-web-site'; Src = 'C:\Users\Admin\projects\Danatar_web_site' },
  @{ Name = 'email-builder-web-2'; Src = 'C:\Users\Admin\projects\email-builder-web 2' },
  @{ Name = 'email-builder-team-project'; Src = 'C:\Users\Admin\projects\email-builder-web-team-ready' },
  @{ Name = 'sputnik-admin-bot'; Src = 'C:\Users\Admin\projects\Sputinik_admin_bot' },
  @{ Name = 'tiptap-project'; Src = 'C:\Users\Admin\projects\tiptap' },
  @{ Name = 'vpn-web'; Src = 'C:\Users\Admin\projects\vpn web' },
  @{ Name = 'projects-web'; Src = 'C:\Users\Admin\projects\web' },
  @{ Name = 'campaign-assets'; Src = 'C:\Users\Admin\campaigns' },
  @{ Name = 'email-assets'; Src = 'C:\Users\Admin\emails' },
  @{ Name = 'ops-scripts'; Src = 'C:\Users\Admin\Scripts' },
  @{ Name = 'vaalpod1-local-site'; Src = 'C:\Users\Admin\Local Sites\vaalpod1' }
)

$excludedDirNames = @('.git','node_modules','venv','.venv','__pycache__','.dart_tool','.gradle','libs','dist','build','.next','.astro','coverage','releases','android-client','hiddify-dada-android','.tmp-deploy-inspect','tmp','backup','backups','logs','.cache','.playwright-mcp','target')
$excludedFiles = @('.env','.env.*','*.pem','*.key','*.p12','*.pfx','*password*','*secret*','*credential*','client_secret*.json','service-account*.json','access.txt','*.sqlite','*.sqlite3','*.db','*.log','*.bak','*.zip','*.tar','*.gz')
$results = @()

foreach ($p in $projects) {
  if (!(Test-Path -LiteralPath $p.Src)) { Write-Output "SKIP missing $($p.Src)"; continue }
  $repo = ("archive-$stamp-$($p.Name)").ToLower() -replace '[^a-z0-9-]', '-'
  $dest = Join-Path $stageRoot $repo
  New-Item -ItemType Directory -Path $dest | Out-Null
  $args = @($p.Src, $dest, '/E','/COPY:DAT','/DCOPY:DAT','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XJ')
  $args += '/XD'; $args += $excludedDirNames
  $args += '/XF'; $args += $excludedFiles
  & robocopy @args | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Robocopy failed for $($p.Name): $LASTEXITCODE" }

  $large = Get-ChildItem -LiteralPath $dest -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 90MB }
  $largeCount = 0
  foreach ($f in $large) { Remove-Item -LiteralPath $f.FullName -Force; $largeCount++ }

  $secretCount = 0

  $files = (Get-ChildItem -LiteralPath $dest -File -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($files -eq 0) { Write-Output "SKIP empty $repo"; Remove-Item -LiteralPath $dest -Recurse -Force; continue }
  Push-Location $dest
  git init -q
  git config user.name 'Dayanchk15'
  git config user.email 'dayanchk15@gmail.com'
  git add -A 2>$null
  git commit -qm "Archive local project $stamp" 2>$null
  Pop-Location
  $results += [pscustomobject]@{ Repo = $repo; Source = $p.Src; Files = $files; RemovedLarge = $largeCount; RemovedSecretFiles = $secretCount; Path = $dest }
  Write-Output "READY $repo files=$files large-removed=$largeCount secret-files-removed=$secretCount"
}

Write-Output "STAGE=$stageRoot"
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageRoot 'manifest.json') -Encoding UTF8
$results | Format-Table Repo,Files,RemovedLarge,RemovedSecretFiles -AutoSize
