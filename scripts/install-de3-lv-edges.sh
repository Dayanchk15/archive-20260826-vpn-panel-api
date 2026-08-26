#!/bin/bash
# Install relay edges on DE3 + LV from panel VPS host.
set -euo pipefail
ROOT="/opt/vpn-panel-api-vps"
bash "$ROOT/scripts/install-edge-host.sh" relay-eu-de3 8086 162.217.248.32 2222 0
bash "$ROOT/scripts/install-edge-host.sh" relay-eu-lv 8083 61.245.11.253 22 1

docker restart vpn-panel-api-vps
sleep 6
docker exec vpn-panel-api-vps node -e "import('/app/lib/relay-edge-sync.js').then(async m=>{const r=await m.syncRelayVpsEdges({force:true}); console.log(JSON.stringify({ok:r.ok,clientCount:r.clientCount,edges:r.edges},null,2));})"

