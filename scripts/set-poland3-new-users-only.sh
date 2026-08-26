#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
echo "=== poland3: new users only ==="
docker cp scripts/set-poland3-new-users-only.mjs vpn-panel-api-vps:/app/scripts/set-poland3-new-users-only.mjs
docker exec vpn-panel-api-vps node scripts/set-poland3-new-users-only.mjs
