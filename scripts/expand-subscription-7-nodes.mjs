#!/usr/bin/env node
/**
 * 7+ nodes in subscription: disable one-per-country, warm 7th node (neth9), refresh.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/expand-subscription-7-nodes.mjs
 */
import { listServers, listUsers, updateServer } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const WARM_CORE = [
  'neth5',
  'neth8',
  'neth9',
  'singapore2',
  'germany13',
  'germany15',
  'germany16',
];

await updatePanelSettings({
  subscriptionWarmOnly: true,
  subscriptionOnePerCountry: false,
  subscriptionMinServers: 7,
});

const panel = await getPanelSettings();
const servers = await listServers();
const byService = new Map(servers.map((s) => [s.service, s]));

const warmed = [];
for (const service of WARM_CORE) {
  const server = byService.get(service);
  if (!server || server.enabled === false) {
    warmed.push({ service, ok: false, error: 'missing or disabled' });
    continue;
  }
  await updateServer(server.id, {
    minInstances: 1,
    maxInstances: 2,
    cpu: 2,
    memory: '2Gi',
    updatedAt: nowIso(),
  });
  const fresh = {
    ...server,
    minInstances: 1,
    maxInstances: 2,
    cpu: 2,
    memory: '2Gi',
  };
  try {
    const deploy = await applyCloudRunServerPanelState(fresh);
    warmed.push({ service, ok: deploy.ok, skipped: deploy.skipped });
  } catch (err) {
    warmed.push({ service, ok: false, error: err.message || String(err) });
  }
  await new Promise((r) => setTimeout(r, 15000));
}

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const { buildAutoSubscription } = await import('../lib/subscription.js');
const sample = (await listUsers())[0];
const body = sample ? await buildAutoSubscription(sample) : '';
const count = body ? body.split('\n').filter((l) => l.startsWith('vless://')).length : 0;

console.log(
  JSON.stringify(
    {
      ok: true,
      panel: {
        subscriptionMinServers: panel.subscriptionMinServers,
        subscriptionOnePerCountry: panel.subscriptionOnePerCountry,
        subscriptionWarmOnly: panel.subscriptionWarmOnly,
      },
      warmDeploy: warmed,
      usersRefreshed: refreshed,
      sampleVlessCount: count,
    },
    null,
    2
  )
);
