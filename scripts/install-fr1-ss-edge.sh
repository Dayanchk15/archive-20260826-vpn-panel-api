#!/bin/bash
# FR1 SS pilot: local VLESS :18088 + TCP:8088 -> WS bridge (websocat).
# Run on FR1 VPS 185.209.230.14 as root.
set -euo pipefail

EDGE_DIR=/opt/vpn-relay-edge
PUBLIC_PORT=8088
LOCAL_PORT=18088
WEBSOCAT=/usr/local/bin/websocat
XRAY=/usr/local/bin/xray
BRIDGE_UNIT=vpn-fr1-tcp-ws-bridge

echo "=== backup ==="
if [ -f "$EDGE_DIR/config.json" ]; then
  cp -a "$EDGE_DIR/config.json" "$EDGE_DIR/config.json.bak-ws-$(date +%Y%m%d%H%M%S)"
fi

echo "=== install websocat if missing ==="
if [ ! -x "$WEBSOCAT" ]; then
  curl -fsSL -o "$WEBSOCAT" \
    "https://github.com/vi/websocat/releases/download/v1.12.0/websocat.x86_64-unknown-linux-musl"
  chmod +x "$WEBSOCAT"
fi

echo "=== waiting for config.json (upload from panel) ==="
for i in $(seq 1 30); do
  if [ -f "$EDGE_DIR/config.json" ]; then
    break
  fi
  sleep 2
done
if [ ! -f "$EDGE_DIR/config.json" ]; then
  echo "missing $EDGE_DIR/config.json"
  exit 1
fi

"$XRAY" run -test -config "$EDGE_DIR/config.json"
pkill -f "xray run -c $EDGE_DIR/config.json" 2>/dev/null || true
sleep 1
nohup "$XRAY" run -c "$EDGE_DIR/config.json" >/var/log/vpn-relay-edge-local.log 2>&1 &
sleep 2

if ! ss -tlnp | grep -q ":${LOCAL_PORT}\\b"; then
  echo "xray not listening on ${LOCAL_PORT}"
  exit 1
fi

echo "=== stop old public xray on ${PUBLIC_PORT} if any ==="
pkill -f "xray.*:${PUBLIC_PORT}" 2>/dev/null || true

echo "=== systemd bridge ${PUBLIC_PORT} -> ws://127.0.0.1:${LOCAL_PORT}/ ==="
systemctl stop "$BRIDGE_UNIT" 2>/dev/null || true
pkill -f "websocat.*${PUBLIC_PORT}" 2>/dev/null || true

cat >/etc/systemd/system/${BRIDGE_UNIT}.service <<EOF
[Unit]
Description=FR1 TCP to local VLESS WS bridge (SS pilot)
After=network.target

[Service]
Type=simple
ExecStart=${WEBSOCAT} tcp-l:0.0.0.0:${PUBLIC_PORT} ws://127.0.0.1:${LOCAL_PORT}/
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$BRIDGE_UNIT"
systemctl restart "$BRIDGE_UNIT"
sleep 2

if ! ss -tlnp | grep -q ":${PUBLIC_PORT}\\b"; then
  echo "bridge not listening on ${PUBLIC_PORT}"
  systemctl status "$BRIDGE_UNIT" --no-pager || true
  exit 1
fi

echo "OK fr1-ss-pilot local=${LOCAL_PORT} public=${PUBLIC_PORT}"
