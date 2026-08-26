#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/sbin
EDGE_DIR=/opt/vpn-relay-edge
EDGE_PORT="${1:?port}"
EDGE_ID="${2:?edge id}"
REPORT_URL="${3:?report url}"
REPORT_KEY="${4:?report key}"
REMOTE_TAR="${5:?tar}"
CLIENTS_JSON="${6:?clients}"

rm -rf "$EDGE_DIR"
mkdir -p "$EDGE_DIR"
tar -xzf "$REMOTE_TAR" -C "$EDGE_DIR"
find "$EDGE_DIR" -type f \( -name '*.sh' -o -name '*.yml' -o -name '*.js' \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true
chmod +x "$EDGE_DIR/install-edge-on-vps.sh"
export EDGE_PORT
export VLESS_CLIENTS_JSON_FILE="$CLIENTS_JSON"
export PANEL_REPORT_URL="$REPORT_URL"
export EDGE_REPORT_KEY="$REPORT_KEY"
export TRAFFIC_NODE_ID="$EDGE_ID"
SKIP_DOCKER_COMPOSE=1 "$EDGE_DIR/install-edge-on-vps.sh"
ss -tlnp | grep -E ":${EDGE_PORT}\\b" || true
