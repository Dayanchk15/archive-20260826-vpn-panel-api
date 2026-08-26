#!/bin/bash
set -euo pipefail

CONFIG="${CONFIG:?CONFIG is required}"
XRAY_SERVICE="${XRAY_SERVICE:?XRAY_SERVICE is required}"
INBOUND_TAG="${INBOUND_TAG:?INBOUND_TAG is required}"
API_PORT="${API_PORT:?API_PORT is required}"
API_LISTEN="${API_LISTEN:-127.0.0.1}"
CLIENT_FLOW="${CLIENT_FLOW:-}"
EDGE_DIR="${EDGE_DIR:?EDGE_DIR is required}"
TRAFFIC_NODE_ID="${TRAFFIC_NODE_ID:?TRAFFIC_NODE_ID is required}"
TRAFFIC_UNIT_NAME="${TRAFFIC_UNIT_NAME:?TRAFFIC_UNIT_NAME is required}"
PRODUCTION_MATCH="${PRODUCTION_MATCH:-}"
TAMPA_DOCKER_API_MAPPING="${TAMPA_DOCKER_API_MAPPING:-false}"

[ -s "$CONFIG" ] || { echo "Xray config is missing: $CONFIG" >&2; exit 1; }
[ -s /tmp/pilot-edge-clients.json ] || { echo "Client registry upload is missing" >&2; exit 1; }
[ -s /tmp/configure-standalone-edge.py ] || { echo "Config patcher upload is missing" >&2; exit 1; }
[ -s /tmp/install-standalone-traffic-reporter.sh ] || { echo "Reporter installer upload is missing" >&2; exit 1; }

PRODUCTION_PID_BEFORE=""
if [ -n "$PRODUCTION_MATCH" ]; then
  PRODUCTION_PID_BEFORE="$(pgrep -f "$PRODUCTION_MATCH" || true)"
  [ -n "$PRODUCTION_PID_BEFORE" ] || { echo "Production process is not running" >&2; exit 1; }
fi

python3 /tmp/configure-standalone-edge.py \
  --config "$CONFIG" \
  --clients /tmp/pilot-edge-clients.json \
  --inbound-tag "$INBOUND_TAG" \
  --api-port "$API_PORT" \
  --api-listen "$API_LISTEN" \
  --flow "$CLIENT_FLOW"

BACKUP=""
for candidate in "${CONFIG}.pre-panel-traffic-"*; do
  [ -s "$candidate" ] && BACKUP="$candidate"
done
[ -s "$BACKUP" ] || { echo "Config backup was not created" >&2; exit 1; }

UNIT_BACKUP=""
rollback() {
  echo "Pilot deployment failed; restoring previous config" >&2
  cp "$BACKUP" "$CONFIG"
  if [ -n "$UNIT_BACKUP" ] && [ -s "$UNIT_BACKUP" ]; then
    cp "$UNIT_BACKUP" "/etc/systemd/system/${XRAY_SERVICE}.service"
    systemctl daemon-reload
  fi
  systemctl restart "$XRAY_SERVICE" 2>/dev/null || true
}
trap rollback ERR

/usr/local/bin/xray run -test -config "$CONFIG"

if [ "$TAMPA_DOCKER_API_MAPPING" = "true" ]; then
  UNIT_FILE="/etc/systemd/system/${XRAY_SERVICE}.service"
  UNIT_BACKUP="${UNIT_FILE}.pre-panel-traffic"
  cp "$UNIT_FILE" "$UNIT_BACKUP"
  python3 - "$UNIT_FILE" "$API_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
port = sys.argv[2]
text = path.read_text()
mapping = f"-p 127.0.0.1:{port}:{port}/tcp"
if mapping not in text:
    marker = "-p 0.0.0.0:9443:9443/tcp"
    if marker not in text:
        raise SystemExit("Tampa Docker public port mapping not found")
    text = text.replace(marker, f"{marker} {mapping}", 1)
path.write_text(text)
PY
  systemctl daemon-reload
fi

systemctl restart "$XRAY_SERVICE"
sleep 3
systemctl is-active --quiet "$XRAY_SERVICE"
/usr/local/bin/xray api statsquery --server="127.0.0.1:${API_PORT}" -pattern traffic >/dev/null

if [ -n "$PRODUCTION_MATCH" ]; then
  PRODUCTION_PID_AFTER="$(pgrep -f "$PRODUCTION_MATCH" || true)"
  [ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ] || {
    echo "Production process changed unexpectedly" >&2
    exit 1
  }
fi

EDGE_DIR="$EDGE_DIR" \
TRAFFIC_NODE_ID="$TRAFFIC_NODE_ID" \
XRAY_API_PORT="$API_PORT" \
TRAFFIC_UNIT_NAME="$TRAFFIC_UNIT_NAME" \
bash /tmp/install-standalone-traffic-reporter.sh

trap - ERR
CLIENT_COUNT="$(python3 -c "import json; print(len(json.load(open('/tmp/pilot-edge-clients.json'))))")"
echo "STANDALONE_EDGE_OK node=${TRAFFIC_NODE_ID} clients=${CLIENT_COUNT}"
