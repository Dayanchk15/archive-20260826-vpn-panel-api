#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
set -a
source .env.vps
set +a
echo "=== sync status ==="
curl -fsS -H "x-admin-key: ${ADMIN_API_KEY}" "http://127.0.0.1:8081/admin/sync-edge/status" | head -c 1000
echo ""
echo "=== traffic rows last hour ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -t -c "SELECT COUNT(*) FROM traffic_usage WHERE updated_at > NOW() - INTERVAL '1 hour';" 2>/dev/null || echo "traffic query failed"
echo "=== background sync (tail) ==="
docker logs vpn-panel-api-vps 2>&1 | grep -E 'background-sync|traffic/report|sync-edge' | tail -10
