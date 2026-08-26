#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
echo "=== Create poland3 (8 CPU / 4Gi) ==="
docker exec vpn-panel-api-vps node scripts/create-poland3-8cpu.mjs
