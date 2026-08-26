#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
bash scripts/sync-edge-vps.sh 2>&1 | tail -8
echo "=== traffic_usage_nodes (24h) ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -t -c "SELECT COUNT(*) FROM traffic_usage_nodes WHERE updated_at > NOW() - INTERVAL '24 hours';"
