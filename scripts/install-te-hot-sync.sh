#!/bin/bash
# Install pull-based hot-sync for a Tencent EdgeOne WS origin.
# Env: EDGE_ID CONFIG UNIT INBOUND_TAG API_PORT AGENT_PORT
set -euo pipefail

EDGE_ID="${EDGE_ID:?}"
CONFIG="${CONFIG:?}"
UNIT="${UNIT:?}"
INBOUND_TAG="${INBOUND_TAG:?}"
API_PORT="${API_PORT:?}"
AGENT_PORT="${AGENT_PORT:?}"
TARGET_DIR="${TARGET_DIR:-/opt/vpn-standalone-sync-${EDGE_ID}}"
EDGE_ENV_FILE="$(dirname "$CONFIG")/sync.env"
XRAY_BIN="${XRAY_BIN:-}"

# Reuse the Bunny XHTTP installer body (same agent + API patch).
export CONFIG UNIT INBOUND_TAG API_PORT AGENT_PORT EDGE_ID TARGET_DIR EDGE_ENV_FILE
if [ -n "$XRAY_BIN" ]; then export XRAY_BIN; fi
bash /tmp/install-bunny-xhttp-hot-sync.sh
