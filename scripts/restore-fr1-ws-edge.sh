#!/bin/bash
# Rollback FR1 VPS from SS pilot bridge to public VLESS WS on :8088
set -euo pipefail

EDGE_DIR=/opt/vpn-relay-edge
PUBLIC_PORT=8088
LOCAL_PORT=18088
BRIDGE_UNIT=vpn-fr1-tcp-ws-bridge
XRAY=/usr/local/bin/xray

echo "=== stop bridge ==="
systemctl stop "$BRIDGE_UNIT" 2>/dev/null || true
systemctl disable "$BRIDGE_UNIT" 2>/dev/null || true
pkill -f "websocat.*${PUBLIC_PORT}" 2>/dev/null || true

echo "=== stop local pilot xray ==="
pkill -f "xray run -c ${EDGE_DIR}/config.json" 2>/dev/null || true
sleep 1

echo "=== restore config backup ==="
bak="$(ls -t "${EDGE_DIR}"/config.json.bak-ws-* 2>/dev/null | head -1 || true)"
if [ -z "$bak" ]; then
  echo "ERROR: no config.json.bak-ws-* backup in ${EDGE_DIR}"
  exit 1
fi
cp -a "$bak" "${EDGE_DIR}/config.json"
echo "restored from $bak"

"$XRAY" run -test -config "${EDGE_DIR}/config.json"
nohup "$XRAY" run -c "${EDGE_DIR}/config.json" >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2

if ! ss -tlnp | grep -q ":${PUBLIC_PORT}\\b"; then
  echo "ERROR: xray not listening on ${PUBLIC_PORT}"
  ss -tlnp | grep -E "${PUBLIC_PORT}|${LOCAL_PORT}" || true
  exit 1
fi

if ss -tlnp | grep -q ":${LOCAL_PORT}\\b"; then
  echo "WARN: still listening on ${LOCAL_PORT}"
fi

echo "OK fr1-ws-restored public=${PUBLIC_PORT}"
