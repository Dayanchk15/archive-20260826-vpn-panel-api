#!/usr/bin/env node
/**
 * Subscription: 3× NL + 1× SG + 3× DE (7 total). Warm stays neth8, germany13, singapore2.
 */
import { listUsers } from '../lib/db-store.js';
import { updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';

await updatePanelSettings({
  subscriptionMinServers: 7,
  subscriptionWarmOnly: true,
  subscriptionOnePerCountry: false,
});

const sync = await syncVpnEdgeClientsPhased({ maxParallel: 2 }).catch((e) => ({
  ok: false,
  error: e.message,
}));

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const { buildAutoSubscription } = await import('../lib/subscription.js');
const sample = (await listUsers())[0];
const body = sample ? await buildAutoSubscription(sample) : '';
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
const names = lines.map((l) => {
  try {
    return decodeURIComponent((l.split('#')[1] || '').split('?')[0]);
  } catch {
    return '?';
  }
});

console.log(
  JSON.stringify(
    {
      ok: true,
      subscriptionMinServers: 7,
      serversInSub: lines.length,
      names,
      syncOk: sync.ok,
      usersRefreshed: refreshed,
      pool: ['neth8', 'neth9', 'neth11', 'singapore2', 'germany13', 'germany15', 'germany17'],
    },
    null,
    2
  )
);
