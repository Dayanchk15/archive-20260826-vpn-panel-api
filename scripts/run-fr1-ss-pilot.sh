#!/usr/bin/env bash
# Orchestrate FR1 SS pilot from workstation -> panel VPS + FR1 edge.
set -euo pipefail

PANEL=root@45.140.42.39
FR1=root@185.209.230.14
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILES=/opt/vpn-panel/files
PASS="${CONTABO_SSH_PASS:-}"

echo "=== upload go relay + scripts ==="
ssh -o ServerAliveInterval=30 "$PANEL" "mkdir -p $FILES/vpn-ws-relay-go"
scp -o ServerAliveInterval=30 -r \
  "$ROOT/vpn-ws-relay-go/"* \
  "$PANEL:$FILES/vpn-ws-relay-go/"
scp -o ServerAliveInterval=30 \
  "$ROOT/scripts/generate-fr1-local-vless-config.mjs" \
  "$ROOT/scripts/deploy-fr1-ss-pilot.mjs" \
  "$ROOT/scripts/verify-fr1-ss-pilot.mjs" \
  "$ROOT/scripts/rollback-fr1-ss-pilot.mjs" \
  "$ROOT/scripts/install-fr1-ss-edge.sh" \
  "$ROOT/lib/cloud-run-relay-deploy.js" \
  "$PANEL:$FILES/"

echo "=== patch panel lib ==="
ssh "$PANEL" "docker cp $FILES/cloud-run-relay-deploy.js vpn-panel-api-vps:/app/lib/cloud-run-relay-deploy.js"

echo "=== generate local vless config on panel ==="
ssh "$PANEL" "docker exec vpn-panel-api-vps node /data/files/generate-fr1-local-vless-config.mjs"
ssh "$PANEL" "docker cp vpn-panel-api-vps:/tmp/fr1-local-vless-config.json $FILES/fr1-local-vless-config.json"

echo "=== install FR1 edge bridge ==="
if [ -z "$PASS" ]; then
  echo "CONTABO_SSH_PASS not set — copy config and run install-fr1-ss-edge.sh on FR1 manually"
else
  sshpass -p "$PASS" scp -o StrictHostKeyChecking=accept-new \
    "$ROOT/scripts/install-fr1-ss-edge.sh" \
    "$PANEL:$FILES/fr1-local-vless-config.json" \
    "$FR1:/tmp/"
  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=accept-new "$FR1" \
    "mkdir -p /opt/vpn-relay-edge && cp /tmp/fr1-local-vless-config.json /opt/vpn-relay-edge/config.json && sed -i 's/\r$//' /tmp/install-fr1-ss-edge.sh && bash /tmp/install-fr1-ss-edge.sh"
fi

echo "=== build + deploy FR1 relay ==="
ssh "$PANEL" "docker exec vpn-panel-api-vps node /data/files/deploy-fr1-ss-pilot.mjs"

echo "=== verify FR1 ==="
ssh "$PANEL" "docker exec vpn-panel-api-vps node /data/files/verify-fr1-ss-pilot.mjs"
ssh "$PANEL" "docker exec vpn-panel-api-vps node /app/scripts/tmp-probe-all-8.mjs"
