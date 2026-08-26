#!/usr/bin/env bash
set -euo pipefail

EDGE_DIR=/opt/vpn-gcore-fr1-ws
SOURCE_DIR=/opt/vpn-cloudflare-ws
SOURCE_XRAY=/usr/local/bin/xray
CONFIG="$EDGE_DIR/config.json"
XRAY="$EDGE_DIR/bin/xray"
UNIT=/etc/systemd/system/xray-gcore-fr1-ws.service
CADDY_FRAGMENT=/etc/caddy/conf.d/gcore-fr1-online.caddy
PUBLIC_HOST=gcore-fr1.levospeed.online
WS_PATH=/gcore/fr1/7f34d9a28c61/ws
XRAY_PORT=18095
API_PORT=10095
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/root/backups/gcore-fr1-ws-$STAMP"

test -x "$SOURCE_XRAY"
test -s "$SOURCE_DIR/config.json"
install -d -m 700 "$BACKUP_DIR"

for item in "$EDGE_DIR" "$UNIT" "$CADDY_FRAGMENT"; do
  if [ -e "$item" ]; then
    cp -a "$item" "$BACKUP_DIR/"
  fi
done

install -d -m 755 "$EDGE_DIR/bin"
install -m 755 "$SOURCE_XRAY" "$XRAY"

python3 - "$SOURCE_DIR/config.json" "$CONFIG" "$WS_PATH" "$XRAY_PORT" "$API_PORT" <<'PY'
import copy
import json
import sys

source, destination, ws_path, xray_port, api_port = sys.argv[1:]
with open(source, encoding='utf-8') as handle:
    config = json.load(handle)

config = copy.deepcopy(config)
config['log'] = {
    'loglevel': 'warning',
    'access': '/var/log/xray-gcore-fr1-ws-access.log',
    'error': '/var/log/xray-gcore-fr1-ws-error.log',
}

vless = next(item for item in config['inbounds'] if item.get('protocol') == 'vless')
vless['listen'] = '127.0.0.1'
vless['port'] = int(xray_port)
vless['tag'] = 'gcore-fr1-ws-in'
vless['streamSettings'] = {
    'network': 'ws',
    'security': 'none',
    'wsSettings': {
        'path': ws_path,
        'acceptProxyProtocol': False,
    },
}

api_inbound = next((item for item in config['inbounds'] if item.get('protocol') == 'dokodemo-door'), None)
if api_inbound:
    api_inbound['listen'] = '127.0.0.1'
    api_inbound['port'] = int(api_port)
    api_inbound['tag'] = 'api'

with open(destination, 'w', encoding='utf-8') as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
PY

chmod 600 "$CONFIG"
"$XRAY" run -test -config "$CONFIG"

cat >"$UNIT" <<EOF
[Unit]
Description=Levospeed FR1 Gcore VLESS WebSocket origin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -config $CONFIG
Restart=always
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

cat >"$CADDY_FRAGMENT" <<EOF
http://$PUBLIC_HOST {
    @gcore_ws path $WS_PATH
    handle @gcore_ws {
        reverse_proxy 127.0.0.1:$XRAY_PORT {
            flush_interval -1
        }
    }
    handle {
        respond 404
    }
}
EOF

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now xray-gcore-fr1-ws.service
systemctl reload caddy

systemctl is-active --quiet xray-gcore-fr1-ws.service
ss -lnt | grep -q "127.0.0.1:$XRAY_PORT"
ss -lnt | grep -q "127.0.0.1:$API_PORT"

echo "GCORE_FR1_SERVER_READY host=$PUBLIC_HOST path=$WS_PATH origin=185.209.230.14:80 xray=127.0.0.1:$XRAY_PORT api=127.0.0.1:$API_PORT backup=$BACKUP_DIR"
