#!/bin/sh
set -u

echo HOST="$(hostname)"
echo AGENT_ENVS
find /opt -maxdepth 5 -name agent.env -type f 2>/dev/null | while read -r file; do
  echo FILE="$file"
  grep -E '^(EDGE_ID|XRAY_BIN|XRAY_API_ADDR|XRAY_INBOUND_TAG|AGENT_PORT|PANEL_PULL_URL)=' "$file" 2>/dev/null |
    sed -E 's#(PANEL_PULL_URL=).*#\1<redacted>#'
done

echo XRAY_PROCESSES
pgrep -af 'xray.*run|/xray run' 2>/dev/null || true

echo XRAY_LISTENERS
ss -lntp 2>/dev/null | grep -E 'xray|:1008[0-9]|:808[0-9]' || true

echo XRAY_CONFIGS
find /opt -maxdepth 4 -name config.json -type f 2>/dev/null | while read -r file; do
  python3 - "$file" <<'PY' 2>/dev/null || true
import json
import sys

path = sys.argv[1]
data = json.load(open(path, encoding='utf-8'))
rows = []
for inbound in data.get('inbounds', []):
    rows.append({
        'tag': inbound.get('tag'),
        'port': inbound.get('port'),
        'protocol': inbound.get('protocol'),
        'clients': len(inbound.get('settings', {}).get('clients', [])),
    })
if rows:
    print(path, json.dumps({'api': data.get('api'), 'inbounds': rows}, separators=(',', ':')))
PY
done

echo SERVICES
systemctl list-units --all --type=service --no-legend 2>/dev/null | grep -Ei 'xray|sync|relay' || true
