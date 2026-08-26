#!/usr/bin/env node
/** Fix post-migration: sync germany12, hide broken SG stubs */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { listUsers } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';

for (const s of await listServers()) {
  if (s.service?.startsWith('singapore') && !s.host) {
    await updateServer(s.id, { newUsersOnly: true, enabled: false, updatedAt: nowIso() });
    console.log('disabled stub', s.service);
  }
}

const g12 = (await listServers()).find((s) => s.service === 'germany12');
if (g12?.host) {
  await applyCloudRunServerPanelState(g12);
}

const sync = await syncVpnEdgeClientsPhased({ maxParallel: 2 });
let refreshed = 0;
for (const u of await listUsers()) {
  await upsertUserSubscriptionFile(u);
  refreshed++;
}

const sample = (await listUsers()).find((u) => u.name === 'Makss') || (await listUsers())[0];
const body = await buildUserSubscriptionBody(sample);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      sync,
      refreshed,
      sampleUser: sample.name,
      vlessLines: lines.length,
      servers: lines.map((l) => l.split('#')[1]?.slice(0, 40)),
    },
    null,
    2
  )
);
