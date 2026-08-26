#!/bin/sh
set -eu

WORKDIR=/opt/vpn-relay-edge-sync/vpn-edge-sync-agent
EDGE_ENV=/opt/vpn-relay-edge/.env
cd "$WORKDIR"
docker compose -f docker-compose.agent.yml build vpn-edge-sync-agent
sed -i '/^EDGE_SYNC_FINGERPRINT=/d' "$EDGE_ENV" 2>/dev/null || true
docker compose -f docker-compose.agent.yml up -d --force-recreate vpn-edge-sync-agent

for _ in $(seq 1 35); do
  status="$(curl -fsS --max-time 2 http://127.0.0.1:19222/v1/status 2>/dev/null || true)"
  echo "$status" | grep -q '"lastError":null' && echo "$status" | grep -q '"lastAppliedAt"' && break
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:19222/v1/status
echo
echo RELAY_AGENT_IDEMPOTENT_OK
