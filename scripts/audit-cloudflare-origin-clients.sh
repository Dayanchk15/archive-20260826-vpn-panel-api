#!/bin/bash
set -euo pipefail

UNIT="${1:-xray-cloudflare-ws.service}"
EXEC_START="$(systemctl show -p ExecStart --value "$UNIT")"
CONFIG="$(printf '%s' "$EXEC_START" | sed -nE 's/.*(-config|-c)[ =]([^ ;}]+).*/\2/p')"
[ -n "$CONFIG" ] || CONFIG=/opt/vpn-cloudflare-ws/config.json
[ -r "$CONFIG" ] || { echo "config_not_readable unit=$UNIT config=$CONFIG"; exit 1; }

python3 - "$CONFIG" <<'PY'
import hashlib, json, sys
config = json.load(open(sys.argv[1], encoding='utf-8'))
ids = []
for inbound in config.get('inbounds', []):
    for client in inbound.get('settings', {}).get('clients', []):
        value = str(client.get('id', '')).strip().lower()
        if value:
            ids.append(value)
ids = sorted(set(ids))
print(json.dumps({
    'count': len(ids),
    'fingerprint': hashlib.sha256(','.join(ids).encode()).hexdigest(),
    'hashes': sorted(hashlib.sha256(value.encode()).hexdigest() for value in ids),
}, separators=(',', ':')))
PY
