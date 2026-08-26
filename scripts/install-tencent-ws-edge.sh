#!/bin/bash
# Generic install for Daykoo Tencent EdgeOne VLESS+WS origin.
# Env: EDGE_ID (fr2|fornex|tampa), PORT, WS_PATH, UUID, EMAIL
set -euo pipefail

EDGE_ID="${EDGE_ID:?EDGE_ID required}"
PORT="${PORT:-18108}"
WS_PATH="${WS_PATH:?WS_PATH required}"
UUID="${UUID:?UUID required}"
EMAIL="${EMAIL:-Daykoo VIP}"
XRAY="${XRAY:-/usr/local/bin/xray}"

DIR="/opt/vpn-${EDGE_ID}-tencent-ws"
CONFIG="$DIR/config.json"
UNIT="xray-${EDGE_ID}-tencent-ws.service"
ACCESS="/var/log/vpn-${EDGE_ID}-tencent-ws-access.log"
ERROR="/var/log/vpn-${EDGE_ID}-tencent-ws-error.log"

if [[ ! -x "$XRAY" ]]; then
  echo "xray binary missing: $XRAY" >&2
  exit 1
fi
if [[ ! "$WS_PATH" =~ ^/ ]]; then
  echo "WS_PATH must start with /" >&2
  exit 1
fi

# If port taken by foreign process, abort; if by our unit, ok to replace.
if ss -lntH "sport = :$PORT" | grep -q .; then
  EXISTING_UNIT_PID="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || true)"
  LISTENER_PID="$(ss -lntpH "sport = :$PORT" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1)"
  if [ -n "${EXISTING_UNIT_PID:-}" ] && [ "$EXISTING_UNIT_PID" != "0" ] && [ "$LISTENER_PID" = "$EXISTING_UNIT_PID" ]; then
    echo "port $PORT owned by $UNIT — will restart"
  else
    echo "Port $PORT is already used by another service (pid=$LISTENER_PID)" >&2
    ss -lntpH "sport = :$PORT" || true
    exit 1
  fi
fi

mkdir -p "$DIR"
if [ -f "$CONFIG" ]; then
  cp -a "$CONFIG" "$CONFIG.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi

cat >"$CONFIG" <<EOF
{
  "log": {
    "loglevel": "warning",
    "access": "$ACCESS",
    "error": "$ERROR"
  },
  "dns": { "queryStrategy": "UseIPv4", "servers": ["1.1.1.1", "8.8.8.8"] },
  "inbounds": [{
    "tag": "${EDGE_ID}-tencent-ws-in",
    "listen": "0.0.0.0",
    "port": $PORT,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "$UUID", "email": "$EMAIL", "level": 0 }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "ws",
      "security": "none",
      "wsSettings": { "path": "$WS_PATH" },
      "sockopt": {
        "tcpNoDelay": true,
        "tcpKeepAliveIdle": 60,
        "tcpKeepAliveInterval": 30
      }
    },
    "sniffing": { "enabled": true, "destOverride": ["http", "tls"], "routeOnly": true }
  }],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom" },
    { "tag": "block", "protocol": "blackhole" }
  ]
}
EOF
chmod 600 "$CONFIG"
touch "$ACCESS" "$ERROR"
chmod 600 "$ACCESS" "$ERROR"

cat >"/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=${EDGE_ID} isolated Tencent EdgeOne VLESS WebSocket origin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=$XRAY run -config $CONFIG
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

echo "${EDGE_ID}_TENCENT_WS_OK port=$PORT path=$WS_PATH uuid=$UUID"
