#!/bin/sh
set -eu

API_PORT="${1:?v2 API port required}"
COMPOSE=/opt/vpn-relay-edge-sync/vpn-edge-sync-agent/docker-compose.agent.yml
WORKDIR=/opt/vpn-relay-edge-sync/vpn-edge-sync-agent
EDGE_ENV=/opt/vpn-relay-edge/.env
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cp -a "$COMPOSE" "$COMPOSE.pre-relay-v2-$STAMP.bak"
sed -i \
  -e "s/XRAY_API_ADDR: 127.0.0.1:[0-9]*/XRAY_API_ADDR: 127.0.0.1:$API_PORT/" \
  -e 's/XRAY_INBOUND_TAG: vless-ws/XRAY_INBOUND_TAG: vless-tcp-in/' \
  "$COMPOSE"
sed -i '/^EDGE_SYNC_FINGERPRINT=/d' "$EDGE_ENV" 2>/dev/null || true

cd "$WORKDIR"
docker compose -f docker-compose.agent.yml up -d --force-recreate vpn-edge-sync-agent

for _ in $(seq 1 30); do
  status="$(curl -fsS --max-time 2 http://127.0.0.1:19222/v1/status 2>/dev/null || true)"
  echo "$status" | grep -q '"lastError":null' && echo "$status" | grep -q '"lastAppliedAt"' && break
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:19222/v1/status
echo
echo "RELAY_AGENT_V2_OK api=$API_PORT backup=$COMPOSE.pre-relay-v2-$STAMP.bak"
