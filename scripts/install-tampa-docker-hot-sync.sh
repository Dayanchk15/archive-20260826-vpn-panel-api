#!/bin/bash
set -euo pipefail

SOURCE_DIR=/opt/vpn-standalone-sync-pilot-tampa-reality
TARGET_DIR="${1:?target dir required}"
PROJECT="${2:?compose project required}"
CONTAINER_NAME="${3:?container name required}"
EDGE_ID="${4:?edge id required}"
AGENT_PORT="${5:?agent port required}"
EDGE_DIR="${6:?edge dir required}"
API_ADDR="${7:?api addr required}"
INBOUND_TAG="${8:?inbound tag required}"
XRAY_UNIT="${9:?xray unit required}"

systemctl is-active --quiet "$XRAY_UNIT"
test -s "$SOURCE_DIR/.env"
rm -rf "$TARGET_DIR"
cp -a "$SOURCE_DIR" "$TARGET_DIR"
touch "$EDGE_DIR/sync.env"
chmod 600 "$EDGE_DIR/sync.env"

sed -i \
  -e "s/^EDGE_ID=.*/EDGE_ID=$EDGE_ID/" \
  -e "s/^AGENT_PORT=.*/AGENT_PORT=$AGENT_PORT/" \
  -e "s/^CONTAINER_NAME=.*/CONTAINER_NAME=$CONTAINER_NAME/" \
  -e "s#^EDGE_DIR=.*#EDGE_DIR=$EDGE_DIR#" \
  -e "s/^XRAY_API_ADDR=.*/XRAY_API_ADDR=$API_ADDR/" \
  -e "s/^XRAY_INBOUND_TAG=.*/XRAY_INBOUND_TAG=$INBOUND_TAG/" \
  -e 's/^XRAY_CLIENT_FLOW=.*/XRAY_CLIENT_FLOW=/' \
  "$TARGET_DIR/.env"

cd "$TARGET_DIR/vpn-edge-sync-agent"
docker compose -p "$PROJECT" --env-file ../.env -f docker-compose.standalone.yml up -d --build >/dev/null
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:$AGENT_PORT/health" >/dev/null
echo "TAMPA_DOCKER_HOT_SYNC_OK edge=$EDGE_ID port=$AGENT_PORT"
