#!/bin/bash
set -euo pipefail
echo "=== traffic_usage total ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -c "SELECT COUNT(*) AS rows, MAX(updated_at) AS last_update FROM traffic_usage;"
echo "=== traffic_usage_nodes total ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -c "SELECT COUNT(*) AS rows, MAX(updated_at) AS last_update FROM traffic_usage_nodes;"
echo "=== sample traffic_usage ==="
docker exec vpn-panel-postgres psql -U vpn_panel -d vpn_panel -c "SELECT user_id, upload_bytes, download_bytes, updated_at FROM traffic_usage ORDER BY updated_at DESC LIMIT 5;"
