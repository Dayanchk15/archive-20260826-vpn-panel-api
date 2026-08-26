#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
docker cp scripts/monitor-poland3.mjs vpn-panel-api-vps:/app/scripts/monitor-poland3.mjs 2>/dev/null || true
docker exec vpn-panel-api-vps node scripts/monitor-poland3.mjs
