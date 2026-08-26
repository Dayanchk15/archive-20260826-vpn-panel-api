#!/usr/bin/env bash
# Install an isolated plain VLESS + WebSocket origin on FR1 for a Render edge.
# This does not stop or reload production Xray, Caddy, or the existing Bunny node.
set -euo pipefail

XRAY="${XRAY_BIN:-/usr/local/bin/xray}"
PORT="${1:-7865}"
UUID_VALUE="${2:-}"
WS_PATH="${3:-/render-fr1-ws}"
DIR="/opt/vpn-fr1-render-ws"
CONFIG="$DIR/config.json"
UNIT="xray-fr1-render-ws.service"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ ! -x "$XRAY" ]]; then
  echo "xray binary not found: $XRAY" >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "PORT must be between 1024 and 65535" >&2
  exit 1
fi
if [[ ! "$UUID_VALUE" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "Usage: $0 [port] [uuid] [websocket-path]" >&2
  echo "Example: $0 7865 00000000-0000-4000-8000-000000000001 /render-fr1-ws" >&2
  exit 1
fi
if [[ ! "$WS_PATH" =~ ^/[A-Za-z0-9._~:/-]*$ ]]; then
  echo "WebSocket path must start with / and contain no spaces or query string" >&2
  exit 1
fi

# Capture production PIDs so a failed install cannot silently restart them.
RELAY_PID_BEFORE="$(systemctl show -p MainPID --value xray-relay-v2.service 2>/dev/null || true)"
BUNNY_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service 2>/dev/null || true)"
[[ -n "$RELAY_PID_BEFORE" && "$RELAY_PID_BEFORE" != 0 ]] || { echo "xray-relay-v2 is not running" >&2; exit 1; }
[[ -n "$BUNNY_PID_BEFORE" && "$BUNNY_PID_BEFORE" != 0 ]] || { echo "xray-fr1-bunny-xhttp is not running" >&2; exit 1; }
systemctl is-active --quiet xray-relay-v2.service
systemctl is-active --quiet xray-fr1-bunny-xhttp.service

mkdir -p "$DIR"
if [[ -f "$CONFIG" ]]; then
  cp -a "$CONFIG" "$CONFIG.bak-$STAMP"
fi
if [[ -f "/etc/systemd/system/$UNIT" ]]; then
  cp -a "/etc/systemd/system/$UNIT" "/etc/systemd/system/$UNIT.bak-$STAMP"
fi

cat > "$CONFIG" <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "tag": "render-fr1-vless-ws",
    "listen": "0.0.0.0",
    "port": $PORT,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "$UUID_VALUE", "level": 0 }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "ws",
      "security": "none",
      "wsSettings": { "path": "$WS_PATH" }
    },
    "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"] }
  }],
  "outbounds": [{ "protocol": "freedom", "tag": "direct" }]
}
EOF

"$XRAY" run -test -config "$CONFIG"

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Isolated FR1 VLESS WebSocket origin for Render CDN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=$XRAY run -c $CONFIG
Restart=always
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null
sleep 2
systemctl is-active --quiet "$UNIT"
ss -lntp | grep -F ":$PORT" >/dev/null

[[ "$(systemctl show -p MainPID --value xray-relay-v2.service)" == "$RELAY_PID_BEFORE" ]]
[[ "$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service)" == "$BUNNY_PID_BEFORE" ]]

echo "FR1_RENDER_ORIGIN_OK port=$PORT path=$WS_PATH unit=$UNIT"
echo "Open TCP $PORT to Render egress traffic in the FR1 firewall if required."
