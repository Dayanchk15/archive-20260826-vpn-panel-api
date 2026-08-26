#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
set -a
source .env.vps
set +a

echo "=== Health ==="
curl -fsS http://127.0.0.1:8081/health
echo ""

echo "=== Registry (last clients) ==="
curl -fsS -H "x-admin-key: ${ADMIN_API_KEY}" http://127.0.0.1:8081/admin/sync-edge/status | head -c 2000
echo ""

echo "=== Recent users (last 5) ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -c \
  "SELECT id, data->>'name' AS name, data->>'uuid' AS uuid, data->>'status' AS status, enabled, created_at FROM users ORDER BY created_at DESC NULLS LAST LIMIT 8;"

echo "=== Servers enabled ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -c \
  "SELECT id, data->>'name' AS name, enabled, data->>'host' AS host FROM servers ORDER BY sort_order NULLS LAST, id;"
