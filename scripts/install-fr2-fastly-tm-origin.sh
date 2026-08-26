#!/bin/bash
set -euo pipefail

SOURCE_CONFIG="${SOURCE_CONFIG:-/tmp/fr2-fastly-dual.json}"
XRAY_DIR=/opt/vpn-fr2-fastly
XRAY_CONFIG="$XRAY_DIR/config.json"
XRAY_UNIT=xray-fr2-fastly.service
XRAY_TAG=vless-xhttp-plain-fastly
XRAY_PORT=18444
XRAY_API_PORT=10088
SOURCE_AGENT=/opt/vpn-standalone-sync-pilot-fr2-tcp
TARGET_AGENT=/opt/vpn-standalone-sync-pilot-fr2-xhttp
AGENT_ENV="$TARGET_AGENT/agent.env"
AGENT_UNIT=vpn-standalone-sync-pilot-fr2-xhttp.service
AGENT_PORT=19226
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/fr2-fastly-tm-${STAMP}"

[ -s "$SOURCE_CONFIG" ] || { echo "Generated FR2 config is missing" >&2; exit 1; }
[ -s /opt/vpn-relay-edge/config.json ] || { echo "Production relay config is missing" >&2; exit 1; }
[ -d "$SOURCE_AGENT" ] || { echo "FR2 sync-agent source is missing" >&2; exit 1; }
systemctl is-active --quiet vpn-standalone-sync-pilot-fr2-tcp.service

PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PILOT_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
[ -n "$PRODUCTION_PID_BEFORE" ] && [ "$PRODUCTION_PID_BEFORE" != 0 ]
[ -n "$TCP_PILOT_PID_BEFORE" ] && [ "$TCP_PILOT_PID_BEFORE" != 0 ]

mkdir -p "$BACKUP_DIR" "$XRAY_DIR"
[ ! -s "$XRAY_CONFIG" ] || cp "$XRAY_CONFIG" "$BACKUP_DIR/config.json"
[ ! -f "/etc/systemd/system/$XRAY_UNIT" ] || cp "/etc/systemd/system/$XRAY_UNIT" "$BACKUP_DIR/"
[ ! -d "$TARGET_AGENT" ] || cp -a "$TARGET_AGENT" "$BACKUP_DIR/sync-agent"

python3 - "$SOURCE_CONFIG" "$XRAY_CONFIG" "$XRAY_TAG" "$XRAY_API_PORT" <<'PY'
import json
from pathlib import Path
import sys

source_path, target_path, tag, api_port = sys.argv[1:]
source = json.loads(Path(source_path).read_text())
inbound = next((item for item in source.get('inbounds', []) if item.get('tag') == tag), None)
if not inbound:
    raise SystemExit(f'Missing inbound {tag}')
if not inbound.get('settings', {}).get('clients'):
    raise SystemExit('FR2 xHTTP inbound has no clients')

config = {
    **source,
    'log': {
        'access': '/var/log/vpn-fr2-fastly-access.log',
        'error': '/var/log/vpn-fr2-fastly-error.log',
        'loglevel': 'warning',
    },
    'api': {'tag': 'api', 'services': ['HandlerService', 'StatsService']},
    'inbounds': [
        inbound,
        {
            'tag': 'api-in',
            'listen': '127.0.0.1',
            'port': int(api_port),
            'protocol': 'dokodemo-door',
            'settings': {'address': '127.0.0.1'},
        },
    ],
}
routing = config.setdefault('routing', {'domainStrategy': 'AsIs', 'rules': []})
rules = routing.setdefault('rules', [])
rules.insert(0, {'type': 'field', 'inboundTag': ['api-in'], 'outboundTag': 'api'})
Path(target_path).write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'clients': len(inbound['settings']['clients']), 'port': inbound['port']}))
PY

chmod 600 "$XRAY_CONFIG"
/usr/local/bin/xray run -test -config "$XRAY_CONFIG"

cat > "/etc/systemd/system/$XRAY_UNIT" <<'UNIT'
[Unit]
Description=FR2 isolated VLESS xHTTP origin for Fastly
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-fr2-fastly/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$XRAY_UNIT"
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$XRAY_UNIT" && ss -ltnH | awk '{print $4}' | grep -q ":${XRAY_PORT}$" && break
  sleep 1
done
systemctl is-active --quiet "$XRAY_UNIT"
ss -ltnH | awk '{print $4}' | grep -q ":${XRAY_PORT}$"

ufw allow "${XRAY_PORT}/tcp" >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport "$XRAY_PORT" -j ACCEPT 2>/dev/null ||
  iptables -I INPUT -p tcp --dport "$XRAY_PORT" -j ACCEPT

systemctl stop "$AGENT_UNIT" 2>/dev/null || true
rm -rf "$TARGET_AGENT"
cp -a "$SOURCE_AGENT" "$TARGET_AGENT"
sed -i '/^EDGE_SYNC_FINGERPRINT=/d' "$AGENT_ENV"
sed -i '/^VLESS_CLIENTS_JSON=/d' "$AGENT_ENV"
sed -i '/^AGENT_PORT=/d' "$AGENT_ENV"
sed -i '/^EDGE_ENV_FILE=/d' "$AGENT_ENV"
sed -i 's/^EDGE_ID=.*/EDGE_ID=pilot-fr2-tcp/' "$AGENT_ENV"
sed -i "s/^XRAY_API_ADDR=.*/XRAY_API_ADDR=127.0.0.1:${XRAY_API_PORT}/" "$AGENT_ENV"
sed -i "s/^XRAY_INBOUND_TAG=.*/XRAY_INBOUND_TAG=${XRAY_TAG}/" "$AGENT_ENV"
sed -i 's/^XRAY_CLIENT_FLOW=.*/XRAY_CLIENT_FLOW=/' "$AGENT_ENV"
printf '\nAGENT_PORT=%s\nEDGE_ENV_FILE=%s\n' "$AGENT_PORT" "$AGENT_ENV" >> "$AGENT_ENV"

cat > "/etc/systemd/system/$AGENT_UNIT" <<EOF
[Unit]
Description=FR2 Fastly xHTTP client hot-sync
After=network-online.target ${XRAY_UNIT}
Wants=network-online.target
Requires=${XRAY_UNIT}

[Service]
Type=simple
WorkingDirectory=${TARGET_AGENT}
EnvironmentFile=${AGENT_ENV}
ExecStart=/usr/bin/node ${TARGET_AGENT}/vpn-edge-sync-agent/server.mjs
ExecStartPre=/usr/bin/sed -i /^EDGE_SYNC_FINGERPRINT=/d ${AGENT_ENV}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$AGENT_UNIT"
COUNT=0
for _ in $(seq 1 30); do
  STATUS="$(curl -fsS --max-time 3 "http://127.0.0.1:${AGENT_PORT}/v1/status" 2>/dev/null || true)"
  COUNT="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("clientCount", 0))' 2>/dev/null || echo 0)"
  [ "$COUNT" -ge 1 ] && break
  sleep 2
done
[ "$COUNT" -ge 1 ] || { journalctl -u "$AGENT_UNIT" -n 80 --no-pager; exit 1; }

CURRENT_JSON=/tmp/fr2-fastly-current-users.json
set -a
# shellcheck disable=SC1090
source "$AGENT_ENV"
set +a
node "$TARGET_AGENT/vpn-edge/xray-client-diff.js" list > "$CURRENT_JSON"
python3 - "$XRAY_CONFIG" "$CURRENT_JSON" "$XRAY_TAG" <<'PY'
import json
from pathlib import Path
import sys

config_path, current_path = map(Path, sys.argv[1:3])
tag = sys.argv[3]
clients = json.loads(current_path.read_text())
if not clients:
    raise SystemExit('No active clients returned by FR2 xHTTP sync agent')
config = json.loads(config_path.read_text())
inbound = next(item for item in config['inbounds'] if item.get('tag') == tag)
inbound['settings']['clients'] = [
    {'id': item['uuid'], 'email': item.get('email') or f'user-{item["uuid"][:8]}', 'level': 0}
    for item in clients
]
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'durableClientCount': len(clients)}))
PY
rm -f "$CURRENT_JSON"
/usr/local/bin/xray run -test -config "$XRAY_CONFIG"

PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PILOT_PID_AFTER="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
[ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ] || { echo "Production relay PID changed" >&2; exit 1; }
[ "$TCP_PILOT_PID_AFTER" = "$TCP_PILOT_PID_BEFORE" ] || { echo "FR2 TCP pilot PID changed" >&2; exit 1; }

echo "FR2_FASTLY_TM_ORIGIN_OK clients=$COUNT productionPid=$PRODUCTION_PID_AFTER tcpPilotPid=$TCP_PILOT_PID_AFTER backup=$BACKUP_DIR"
