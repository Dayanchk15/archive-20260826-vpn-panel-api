#!/bin/bash
set -euo pipefail
KEY=/opt/vpn-panel-secrets/id_ed25519_edge
echo "=== SSH test ==="
ssh -o BatchMode=yes -o ConnectTimeout=12 -i "$KEY" -p 2222 root@91.224.75.102 hostname

echo "=== Install relay edge ==="
bash /opt/vpn-panel-api-vps/scripts/install-edge-host.sh relay-eu-pl 8087 91.224.75.102 2222 0

echo "=== Relay sync ==="
docker exec vpn-panel-api-vps node -e "
import('/app/lib/relay-edge-sync.js').then(async (m) => {
  const r = await m.syncRelayVpsEdges({ force: true });
  console.log(JSON.stringify({ ok: r.ok, clientCount: r.clientCount, pl: r.edges.find((e) => e.id === 'relay-eu-pl') }, null, 2));
});
"
