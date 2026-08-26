#!/usr/bin/env node
/**
 * Push UUIDs to VPS GLB edge (not Cloud Run). Safe: only touches glbPilot server.
 *
 * Env:
 *   SERVER_ID=glb-vps-1
 *   VPS_SSH=root@1.2.3.4
 *   VPS_EDGE_DIR=/opt/glb-vps-edge
 *   DRY_RUN=1
 */
import { execSync } from 'child_process';
import { listUsers, listServers } from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';
import { resolveUserServerIds } from '../lib/server-assignment.js';
import { getEnabledServers } from '../lib/db-store.js';

const SERVER_ID = String(process.env.SERVER_ID || 'glb-vps-1');
const VPS_SSH = String(process.env.VPS_SSH || '').trim();
const VPS_EDGE_DIR = String(process.env.VPS_EDGE_DIR || '/opt/vpn-panel-api-vps/scripts/glb-vps-pilot');
const DRY_RUN = process.env.DRY_RUN === '1';

const servers = await listServers();
const server = servers.find((s) => s.id === SERVER_ID);
if (!server?.glbPilot && !server?.externalVps) {
  console.error(`Server ${SERVER_ID} is not marked glbPilot/externalVps — abort`);
  process.exit(1);
}

const enabledServers = await getEnabledServers();
const users = await listUsers();
const clients = [];
const seen = new Set();

for (const user of users) {
  if (!isUserActive(user)) continue;
  const bonus = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const assigned = resolveUserServerIds(user, enabledServers).map(String);
  if (!bonus.includes(SERVER_ID) && !assigned.includes(SERVER_ID)) continue;
  const uuid = String(user.uuid || '').trim().toLowerCase();
  if (!uuid || seen.has(uuid)) continue;
  seen.add(uuid);
  clients.push({
    userId: user.id,
    uuid,
    email: user.email || `user-${user.id}`,
    name: user.name || '',
  });
}

const payload = JSON.stringify(clients);
console.log(JSON.stringify({ serverId: SERVER_ID, clientCount: clients.length, dryRun: DRY_RUN }));

if (DRY_RUN) {
  console.log(payload.slice(0, 500));
  process.exit(0);
}

if (!VPS_SSH) {
  console.error('Set VPS_SSH=root@ip');
  process.exit(1);
}

const escaped = payload.replace(/'/g, "'\\''");
const remote = `
set -e
cd '${VPS_EDGE_DIR}'
if grep -q '^VLESS_CLIENTS_JSON=' .env 2>/dev/null; then
  sed -i "s|^VLESS_CLIENTS_JSON=.*|VLESS_CLIENTS_JSON='${escaped}'|" .env
else
  echo "VLESS_CLIENTS_JSON='${escaped}'" >> .env
fi
docker compose -f docker-compose.edge.yml up -d --force-recreate
docker compose -f docker-compose.edge.yml ps
`;
execSync(`ssh -o BatchMode=yes ${VPS_SSH} ${JSON.stringify(remote)}`, {
  stdio: 'inherit',
  shell: true,
});

console.log(JSON.stringify({ ok: true, synced: clients.length }));
