#!/bin/bash
set -euo pipefail

CONFIG=/opt/vpn-fr2-fastly/config.json
UNIT=xray-fr2-fastly.service
SYNC_UNIT=vpn-standalone-sync-pilot-fr2-xhttp.service
TAG=vless-xhttp-plain-fastly
NEW_PATH=/fr2/
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="/root/fr2-fastly-config-before-path-${STAMP}.json"
CHANGED=0

[ -s "$CONFIG" ]
systemctl is-active --quiet "$UNIT"
systemctl is-active --quiet "$SYNC_UNIT"
PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
cp "$CONFIG" "$BACKUP"

rollback() {
  if [ "$CHANGED" = 1 ]; then
    cp "$BACKUP" "$CONFIG"
    /usr/local/bin/xray run -test -config "$CONFIG" >/dev/null 2>&1 || true
    systemctl restart "$UNIT" || true
  fi
}
trap rollback ERR

python3 - "$CONFIG" "$TAG" "$NEW_PATH" <<'PY'
import json
from pathlib import Path
import sys

config_path, tag, new_path = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
config = json.loads(config_path.read_text())
inbound = next((item for item in config.get('inbounds', []) if item.get('tag') == tag), None)
if not inbound:
    raise SystemExit(f'Missing inbound {tag}')
settings = inbound.setdefault('streamSettings', {}).setdefault('xhttpSettings', {})
old_path = settings.get('path')
settings['path'] = new_path
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'oldPath': old_path, 'newPath': new_path, 'clients': len(inbound.get('settings', {}).get('clients', []))}))
PY
CHANGED=1
/usr/local/bin/xray run -test -config "$CONFIG"
systemctl restart "$UNIT"
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$UNIT" && ss -ltnH | awk '{print $4}' | grep -q ':18444$' && break
  sleep 1
done
systemctl is-active --quiet "$UNIT"
systemctl is-active --quiet "$SYNC_UNIT"
ss -ltnH | awk '{print $4}' | grep -q ':18444$'

PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PID_AFTER="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
[ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ]
[ "$TCP_PID_AFTER" = "$TCP_PID_BEFORE" ]

trap - ERR
echo "FR2_FASTLY_PATH_OK path=$NEW_PATH productionPid=$PRODUCTION_PID_AFTER tcpPilotPid=$TCP_PID_AFTER backup=$BACKUP"
