param([string]$ClientsFile = "$env:TEMP\usa-clients.json")
$clients = Get-Content $ClientsFile -Raw | ConvertFrom-Json
$json = ($clients | ConvertTo-Json -Compress -Depth 5)
$py = @"
import json, pathlib, re
clients = json.loads('$($json -replace "'", "\'")')
p = pathlib.Path('/opt/glb-vps-edge/docker-compose.yml')
text = p.read_text()
line = '      VLESS_CLIENTS_JSON: ' + repr(json.dumps(clients))
text = re.sub(r'      VLESS_CLIENTS_JSON:.*', line, text)
p.write_text(text)
print('clients', len(clients))
"@
$py | ssh -o BatchMode=yes root@74.115.172.101 "python3 -"
ssh -o BatchMode=yes root@74.115.172.101 "cd /opt/glb-vps-edge && docker compose up -d --force-recreate && docker ps --format '{{.Names}} {{.Status}}' | grep glb"
