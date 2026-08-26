#!/bin/bash
set -euo pipefail

EDGE_ID="${EDGE_ID:?EDGE_ID is required}"
EDGE_DIR="${EDGE_DIR:?EDGE_DIR is required}"
XRAY_API_ADDR="${XRAY_API_ADDR:?XRAY_API_ADDR is required}"
XRAY_INBOUND_TAG="${XRAY_INBOUND_TAG:?XRAY_INBOUND_TAG is required}"
XRAY_CLIENT_FLOW="${XRAY_CLIENT_FLOW:-}"
AGENT_PORT="${AGENT_PORT:?AGENT_PORT is required}"
CONTAINER_NAME="${CONTAINER_NAME:?CONTAINER_NAME is required}"
SOURCE=/tmp/standalone-sync-source
KEY_FILE=/tmp/standalone-sync-key
DEPLOY_DIR="/opt/vpn-standalone-sync-${EDGE_ID}"
IMAGE_FALLBACK="${IMAGE_FALLBACK:-}"

[ -s "$SOURCE/vpn-edge-sync-agent/server.mjs" ] || {
  echo "Standalone sync source is missing" >&2
  exit 1
}
[ -s "$SOURCE/vpn-edge/xray-client-diff.js" ] || {
  echo "Xray diff source is missing" >&2
  exit 1
}
[ -s "$KEY_FILE" ] || { echo "Standalone sync key is missing" >&2; exit 1; }
[ -d "$EDGE_DIR" ] || { echo "Edge directory is missing: $EDGE_DIR" >&2; exit 1; }

if [ ! -x /usr/local/bin/xray ]; then
  [ -n "$IMAGE_FALLBACK" ] || {
    echo "Host Xray binary is missing and IMAGE_FALLBACK is empty" >&2
    exit 1
  }
  container_id="$(docker create --entrypoint /bin/true "$IMAGE_FALLBACK")"
  trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' EXIT
  docker cp "$container_id:/usr/local/bin/xray" /usr/local/bin/xray
  docker rm -f "$container_id" >/dev/null
  trap - EXIT
  chmod 755 /usr/local/bin/xray
fi

rm -rf "$DEPLOY_DIR"
install -d -m 700 "$DEPLOY_DIR"
cp -a "$SOURCE/." "$DEPLOY_DIR/"
install -m 600 /dev/null "$EDGE_DIR/sync.env"

key="$(tr -d '\r\n' <"$KEY_FILE")"
[ -n "$key" ] || { echo "Standalone sync key is empty" >&2; exit 1; }
cat >"$DEPLOY_DIR/.env" <<EOF
EDGE_ID=$EDGE_ID
EDGE_SYNC_KEY=$key
PANEL_PULL_URL=https://sub.twidu.com/internal/edge/clients
PANEL_PULL_INTERVAL_MS=15000
AGENT_PORT=$AGENT_PORT
CONTAINER_NAME=$CONTAINER_NAME
EDGE_DIR=$EDGE_DIR
XRAY_HOST_BIN=/usr/local/bin/xray
XRAY_API_ADDR=$XRAY_API_ADDR
XRAY_INBOUND_TAG=$XRAY_INBOUND_TAG
XRAY_CLIENT_FLOW=$XRAY_CLIENT_FLOW
EOF
chmod 600 "$DEPLOY_DIR/.env"

docker compose \
  -f "$DEPLOY_DIR/vpn-edge-sync-agent/docker-compose.standalone.yml" \
  --env-file "$DEPLOY_DIR/.env" \
  up -d --build

for _ in $(seq 1 12); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null
sleep 18
status="$(curl -fsS --max-time 10 "http://127.0.0.1:${AGENT_PORT}/v1/status")"
python3 - "$status" <<'PY'
import json
import sys

status = json.loads(sys.argv[1])
if not status.get("ok"):
    raise SystemExit("Sync status is not OK")
if status.get("lastError"):
    raise SystemExit(f"Sync error: {status['lastError']}")
if int(status.get("clientCount") or 0) < 1:
    raise SystemExit("Sync agent reports no clients")
print(json.dumps({
    "ok": True,
    "edgeId": status.get("edgeId"),
    "clientCount": status.get("clientCount"),
    "lastAppliedAt": status.get("lastAppliedAt"),
    "applyMode": status.get("applyMode"),
}, indent=2))
PY

rm -rf "$SOURCE" "$KEY_FILE"
echo "STANDALONE_SYNC_AGENT_OK edge=$EDGE_ID tag=$XRAY_INBOUND_TAG"
