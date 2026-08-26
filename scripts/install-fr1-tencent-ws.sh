#!/bin/bash
# Install or update only the isolated FR1 Tencent EdgeOne VLESS+WS origin.
set -euo pipefail

XRAY=/usr/local/bin/xray
DIR=/opt/vpn-fr1-tencent-ws
CONFIG="$DIR/config.json"
UNIT=xray-fr1-tencent-ws.service
PORT="${1:-18108}"
PRODUCTION_UNIT=xray-relay-v2.service

PRODUCTION_PID_BEFORE="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test -n "$PRODUCTION_PID_BEFORE"
test "$PRODUCTION_PID_BEFORE" != "0"
systemctl is-active --quiet "$PRODUCTION_UNIT"

if ss -lntH "sport = :$PORT" | grep -q .; then
  EXISTING_UNIT_PID="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || true)"
  LISTENER_PID="$(ss -lntpH "sport = :$PORT" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1)"
  if [ -z "$EXISTING_UNIT_PID" ] || [ "$EXISTING_UNIT_PID" = "0" ] || [ "$LISTENER_PID" != "$EXISTING_UNIT_PID" ]; then
    echo "Port $PORT is already used by another service" >&2
    exit 1
  fi
fi

mkdir -p "$DIR"
if [ -f "$CONFIG" ]; then
  cp -a "$CONFIG" "$CONFIG.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 600 /tmp/fr1-tencent-ws.json "$CONFIG"
touch /var/log/vpn-fr1-tencent-ws-access.log /var/log/vpn-fr1-tencent-ws-error.log
chmod 600 /var/log/vpn-fr1-tencent-ws-access.log /var/log/vpn-fr1-tencent-ws-error.log

cat >/etc/systemd/system/$UNIT <<'EOF'
[Unit]
Description=FR1 isolated Tencent EdgeOne VLESS WebSocket origin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/xray run -config /opt/vpn-fr1-tencent-ws/config.json
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

"$XRAY" run -test -config "$CONFIG"
systemctl daemon-reload
systemctl enable --now "$UNIT"
systemctl restart "$UNIT"
sleep 2

systemctl is-active --quiet "$UNIT"
ss -lntpH "sport = :$PORT" | grep -q xray
PRODUCTION_PID_AFTER="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE"
rm -f /tmp/fr1-tencent-ws.json

echo "FR1_TENCENT_WS_OK port=$PORT productionPid=$PRODUCTION_PID_AFTER"
