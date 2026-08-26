#!/bin/bash
# Install an isolated Bunny WS origin without restarting the production FR2 relay.
set -euo pipefail

PORT="${1:-18090}"
WS_DIR=/opt/vpn-fr2-bunny-ws
CONFIG="$WS_DIR/config.json"
UNIT=xray-fr2-bunny-ws
XRAY=/usr/local/bin/xray

mkdir -p "$WS_DIR"
install -m 600 /tmp/fr2-bunny-ws.json "$CONFIG"

PRODUCTION_PID_BEFORE="$(systemctl show -p MainPID --value xray-relay-v2.service)"
"$XRAY" run -test -config "$CONFIG"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=FR2 isolated VLESS WebSocket origin for Bunny CDN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -c $CONFIG
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2

systemctl is-active --quiet "$UNIT"
ss -lntp | grep -E ":${PORT}\\b" >/dev/null

ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT

PRODUCTION_PID_AFTER="$(systemctl show -p MainPID --value xray-relay-v2.service)"
[ "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_PID_AFTER" ] || {
  echo "Production FR2 PID changed unexpectedly" >&2
  exit 1
}

rm -f /tmp/fr2-bunny-ws.json
echo "FR2_BUNNY_WS_OK port=$PORT productionPid=$PRODUCTION_PID_AFTER"
