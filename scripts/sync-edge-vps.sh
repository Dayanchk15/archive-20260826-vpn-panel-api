#!/bin/bash
set -euo pipefail
cd /opt/vpn-panel-api-vps
set -a
source .env.vps
set +a
curl -fsS -X POST -H "x-admin-key: ${ADMIN_API_KEY}" http://127.0.0.1:8081/admin/sync-edge
