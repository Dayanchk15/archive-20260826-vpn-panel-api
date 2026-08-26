#!/bin/sh
set -eu

EDGE_PORT="${1:?edge port required}"
V2_PORT="${2:?v2 port required}"
API_PORT="${3:?api port required}"
SOURCE_CONFIG="${SOURCE_CONFIG:-/opt/vpn-relay-edge/config.json}"
V2_DIR="${V2_DIR:-/opt/vpn-relay-edge-v2}"
XRAY_BIN="${XRAY_V2_BIN:-/usr/local/bin/xray-relay-v2}"

mkdir -p "$V2_DIR"

if [ ! -f "$XRAY_BIN" ] || [ ! -x "$XRAY_BIN" ]; then
  if [ -f /usr/local/bin/xray-26.3.27 ] && [ -x /usr/local/bin/xray-26.3.27 ]; then
    cp /usr/local/bin/xray-26.3.27 "$XRAY_BIN"
  elif [ -f /usr/local/bin/xray ] && [ -x /usr/local/bin/xray ]; then
    cp /usr/local/bin/xray "$XRAY_BIN"
  else
    container="$(docker ps --filter name=vpn-relay-edge-vpn-relay-edge-1 -q | head -1)"
    [ -n "$container" ]
    docker cp "$container:/usr/local/bin/xray" "$XRAY_BIN"
  fi
  chmod 0755 "$XRAY_BIN"
fi

python3 - "$SOURCE_CONFIG" "$V2_DIR/config.json" "$V2_PORT" "$API_PORT" "${CLIENTS_FILE:-}" <<'PY'
import json
import os
import sys

source, target, v2_port, api_port, clients_file = sys.argv[1:]
data = json.load(open(source, encoding='utf-8'))
vless = [item for item in data.get('inbounds', []) if item.get('protocol') == 'vless']
if len(vless) != 1:
    raise SystemExit(f'expected one VLESS inbound, got {len(vless)}')
vless[0]['listen'] = '0.0.0.0'
vless[0]['port'] = int(v2_port)
vless[0]['tag'] = 'vless-tcp-in'
if clients_file:
    desired = json.load(open(clients_file, encoding='utf-8'))
    vless[0].setdefault('settings', {})['clients'] = [
        {
            'id': item['uuid'],
            'email': item.get('email') or f"user-{item.get('userId', item['uuid'][:8])}",
            'level': 0,
        }
        for item in desired
        if item.get('uuid')
    ]

data['api'] = {'tag': 'api', 'services': ['HandlerService', 'StatsService']}
data['inbounds'] = vless + [{
    'tag': 'api-in',
    'listen': '127.0.0.1',
    'port': int(api_port),
    'protocol': 'dokodemo-door',
    'settings': {'address': '127.0.0.1'},
}]
rules = [
    item for item in data.get('routing', {}).get('rules', [])
    if item.get('inboundTag') not in (['api'], ['api-in'])
]
rules.insert(0, {'type': 'field', 'inboundTag': ['api-in'], 'outboundTag': 'api'})
data.setdefault('routing', {})['rules'] = rules
data['routing'].setdefault('domainStrategy', 'AsIs')
data['log'] = {
    'loglevel': 'warning',
    'access': '/var/log/xray-relay-v2-access.log',
    'error': '/var/log/xray-relay-v2-error.log',
}

tmp = target + '.tmp'
with open(tmp, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
os.replace(tmp, target)
print('clients', len(vless[0].get('settings', {}).get('clients', [])))
PY

"$XRAY_BIN" run -test -c "$V2_DIR/config.json"

cat >/etc/systemd/system/xray-relay-v2.service <<EOF
[Unit]
Description=Levospeed relay Xray v2 (zero-disconnect rollout)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY_BIN run -c $V2_DIR/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/xray-relay-v2-routing.service <<EOF
[Unit]
Description=Route new relay connections to Xray v2
After=xray-relay-v2.service
Requires=xray-relay-v2.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport $EDGE_PORT -j REDIRECT --to-ports $V2_PORT 2>/dev/null || /usr/sbin/iptables -t nat -I PREROUTING 1 -p tcp --dport $EDGE_PORT -j REDIRECT --to-ports $V2_PORT'
ExecStart=/bin/sh -c '/usr/sbin/iptables -C INPUT -p tcp --dport $V2_PORT -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I INPUT 1 -p tcp --dport $V2_PORT -j ACCEPT'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport $EDGE_PORT -j REDIRECT --to-ports $V2_PORT 2>/dev/null || true'
ExecStop=/bin/sh -c '/usr/sbin/iptables -D INPUT -p tcp --dport $V2_PORT -j ACCEPT 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now xray-relay-v2.service
for _ in $(seq 1 20); do
  ss -ltnH | grep -q ":$V2_PORT " && break
  sleep 1
done
ss -ltnH | grep -q ":$V2_PORT "
ss -ltnH | grep -q ":$API_PORT "
systemctl enable --now xray-relay-v2-routing.service
systemctl is-active --quiet xray-relay-v2.service
systemctl is-active --quiet xray-relay-v2-routing.service
echo "RELAY_V2_ZERO_DISCONNECT_OK edge=$EDGE_PORT v2=$V2_PORT api=$API_PORT"
