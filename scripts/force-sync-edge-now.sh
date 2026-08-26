#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
set -a
source .env.vps
set +a
echo "Syncing all UUIDs to 12 nodes..."
OUT=$(curl -fsS -X POST -H "x-admin-key: ${ADMIN_API_KEY}" http://127.0.0.1:8081/admin/sync-edge)
echo "$OUT" | head -c 1500
echo ""
UPD=$(echo "$OUT" | grep -o '"updated":\[[^]]*\]' | head -c 200 || true)
FAIL=$(echo "$OUT" | grep -o '"failed":\[[^]]*\]' | head -c 200 || true)
echo "updated snippet: $UPD"
echo "failed snippet: $FAIL"
REG=$(curl -fsS -H "x-admin-key: ${ADMIN_API_KEY}" http://127.0.0.1:8081/admin/sync-edge/status | grep -o '"activeClients":[0-9]*' || true)
echo "$REG"
