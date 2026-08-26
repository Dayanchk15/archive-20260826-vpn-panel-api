#!/usr/bin/env node
/**
 * Netherlands timeout from TM: align neth masked IP with working France IP (216.58.198.50).
 */
import { listServers, listUsers, updateServer } from '../lib/db-store.js';
import { updatePanelSettings } from '../lib/settings.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const TM_IP = '216.58.198.50';
const NETH = new Set(['neth5', 'neth6']);

await updatePanelSettings({ connectionMode: 'masked', addressIps: [TM_IP, '142.250.180.14'] });

const servers = (await listServers()).filter((s) => NETH.has(s.service) && s.enabled !== false);
for (const server of servers) {
  const patch = {
    addressIp: TM_IP,
    cpu: 1,
    memory: '1Gi',
    minInstances: 1,
    maxInstances: 2,
    updatedAt: nowIso(),
  };
  await updateServer(server.id, patch);
  const result = await applyCloudRunServerPanelState({ ...server, ...patch });
  console.log(
    JSON.stringify({
      service: server.service,
      ip: TM_IP,
      ok: Boolean(result.ok || result.skipped),
      message: result.message || result.error,
    })
  );
  await new Promise((r) => setTimeout(r, 20000));
}

const targetName = process.argv[2] || null;
const users = await listUsers();
let refreshed = 0;
for (const user of users) {
  if (targetName && user.name !== targetName && user.id !== targetName) continue;
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

await new Promise((r) => setTimeout(r, 30000));

const probes = [];
for (const server of servers) {
  const r = await probeMaskedTlsWithRetry(server, TM_IP, { attempts: 2, timeoutMs: 15000 });
  probes.push({ service: server.service, ip: TM_IP, ok: r.ok, status: r.status, ms: r.ms });
}

console.log(JSON.stringify({ done: true, tmIp: TM_IP, subscriptionsRefreshed: refreshed, probes }, null, 2));
