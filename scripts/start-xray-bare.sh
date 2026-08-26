#!/bin/bash
# Bare-metal Xray WS edge (no docker) for Contabo VPS.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin
XRAY=/usr/local/bin/xray
EDGE_DIR=/opt/vpn-relay-edge
PORT="${1:?port}"
CONFIG="$EDGE_DIR/config.json"

if ! [ -x "$XRAY" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1 || true
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v24.12.31/Xray-linux-64.zip" -o /tmp/xray.zip
  unzip -jo /tmp/xray.zip xray -d /usr/local/bin
  chmod +x /usr/local/bin/xray
  rm -f /tmp/xray.zip
fi

"$XRAY" run -test -config "$CONFIG"
pkill -f "xray run -c $CONFIG" 2>/dev/null || true
nohup "$XRAY" run -c "$CONFIG" >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep -E ":${PORT}\\b" || true
