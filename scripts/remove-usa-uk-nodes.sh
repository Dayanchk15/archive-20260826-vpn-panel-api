#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
echo "=== Remove USA + UK Cloud Run nodes ==="
docker cp scripts/remove-usa-uk-nodes.mjs vpn-panel-api-vps:/app/scripts/remove-usa-uk-nodes.mjs
docker exec vpn-panel-api-vps node scripts/remove-usa-uk-nodes.mjs
