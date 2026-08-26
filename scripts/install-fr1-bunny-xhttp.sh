#!/bin/bash
# Install an isolated FR1 Bunny XHTTP origin without restarting or modifying production Xray.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin

XRAY=/usr/local/bin/xray
DIR=/opt/vpn-fr1-bunny-xhttp
CONFIG="$DIR/config.json"
UNIT=xray-fr1-bunny-xhttp
PORT="${1:-18092}"
PRODUCTION_UNIT=xray-relay-v2.service

mkdir -p "$DIR"
install -m 600 /tmp/fr1-bunny-xhttp.json "$CONFIG"

PRODUCTION_PID_BEFORE="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test -n "$PRODUCTION_PID_BEFORE"
test "$PRODUCTION_PID_BEFORE" != "0"
systemctl is-active --quiet "$PRODUCTION_UNIT"

"$XRAY" run -test -config "$CONFIG"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=FR1 isolated Bunny VLESS XHTTP origin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -c $CONFIG
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2

ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT

systemctl is-active --quiet "$UNIT"
ss -lntp | grep -E ":${PORT}\\b" >/dev/null

PRODUCTION_PID_AFTER="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE"
systemctl is-active --quiet "$PRODUCTION_UNIT"

echo "FR1_BUNNY_XHTTP_OK port=${PORT} productionPid=${PRODUCTION_PID_AFTER}"
