#!/usr/bin/env node
/**
 * Fix broken subscription nodes (503 / UUID drift): redeploy warm pool + full sync.
 */
import { listServers, listUsers } from '../lib/db-store.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { probeServerReachability } from '../lib/node-reachability-probe.js';

const SUB_POOL = [
  'neth5',
  'neth8',
  'neth9',
  'singapore2',
  'germany13',
  'germany15',
  'germany16',
];

const servers = (await listServers()).filter((s) => s.enabled !== false);
const pool = SUB_POOL.map((name) => servers.find((s) => s.service === name)).filter(Boolean);

const redeploy = [];
for (const server of pool) {
  try {
    const result = await applyCloudRunServerPanelState(server);
    redeploy.push({ service: server.service, ok: result.ok, skipped: result.skipped });
  } catch (err) {
    redeploy.push({ service: server.service, ok: false, error: err.message || String(err) });
  }
  await new Promise((r) => setTimeout(r, 12000));
}

console.log(JSON.stringify({ phase: 'sync', redeploy }));
const sync = await syncVpnEdgeClientsPhased({ maxParallel: 2 });

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

await new Promise((r) => setTimeout(r, 20000));

const probes = [];
for (const server of pool) {
  const curl = await probeServerReachability(server, { timeoutMs: 25000 });
  probes.push({ service: server.service, ...curl });
}

console.log(
  JSON.stringify(
    {
      ok: probes.every((p) => p.ok),
      sync: { ok: sync.ok, failed: sync.cloudRun?.failed || sync.failed },
      redeploy,
      probes,
      usersRefreshed: refreshed,
      broken: probes.filter((p) => !p.ok).map((p) => p.service),
    },
    null,
    2
  )
);

process.exit(probes.every((p) => p.ok) ? 0 : 1);
