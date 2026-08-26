#!/usr/bin/env node
/**
 * Keep only Germany and Netherlands in the euphoric pool.
 * Disables France/Poland in panel and scales their Cloud Run services to 0.
 * Keeps all remaining Germany/Netherlands nodes warm with 2 CPU / 2Gi memory.
 */
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { updatePanelSettings } from '../lib/settings.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const KEEP = new Set(['germany10', 'neth5', 'neth6']);
const IP = process.env.MASKED_IP || '216.58.198.50';

await updatePanelSettings({ connectionMode: 'masked', addressIps: [IP] });

const servers = (await listServers()).filter((s) => s.cloudRunProfileId === 'gcp-euphoric');
for (const server of servers.sort((a, b) => a.service.localeCompare(b.service))) {
  const keep = KEEP.has(server.service);
  const patch = keep
    ? {
        enabled: true,
        cpu: 2,
        memory: '2Gi',
        minInstances: 1,
        maxInstances: 2,
        addressIp: IP,
        updatedAt: nowIso(),
      }
    : { enabled: false, minInstances: 0, maxInstances: 0, addressIp: IP, updatedAt: nowIso() };

  await updateServer(server.id, patch);
  const result = await applyCloudRunServerPanelState({ ...server, ...patch });
  console.log(
    JSON.stringify({
      service: server.service,
      keep,
      enabled: patch.enabled,
      min: patch.minInstances,
      max: patch.maxInstances,
      ok: Boolean(result.ok || result.skipped),
      action: result.action,
      message: result.message || result.reason,
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10000));
}

const sync = await syncVpnEdgeClients();
let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

console.log(
  JSON.stringify({
    done: true,
    keep: [...KEEP],
    disabled: servers.filter((server) => !KEEP.has(server.service)).map((server) => server.service),
    syncOk: sync.ok,
    subscriptionsRefreshed: refreshed,
  })
);
