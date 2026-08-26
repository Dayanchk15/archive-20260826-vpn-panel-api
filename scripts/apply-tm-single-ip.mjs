#!/usr/bin/env node
/** Apply single TM Google IP to all servers + refresh subscriptions (no Cloud Run reconcile). */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerById, listServers, listUsers, upsertServer } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { TM_GOOGLE_ADDRESS_IPS } from '../lib/tm-google-ips.js';
import { nowIso } from '../lib/dates.js';

const TM_IP = TM_GOOGLE_ADDRESS_IPS[0];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_PATH = process.env.TM_POOL_JSON || path.join(__dirname, '..', 'cloud-run-deployer', 'nodes.euphoric-pool.json');

const pool = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
const now = nowIso();
let serversUpdated = 0;

for (const node of pool.nodes || []) {
  const existing = await getServerById(node.id);
  if (!existing) continue;
  await upsertServer(node.id, {
    addressIp: TM_IP,
    updatedAt: now,
  });
  serversUpdated += 1;
}

const panel = await getPanelSettings();
await updatePanelSettings({
  ...panel,
  addressIps: [TM_IP],
  connectionMode: 'masked',
  importUrlMode: 'api',
  subscriptionBaseUrl: 'https://sub.twidu.com',
  updatedAt: now,
});

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const sample = (await listServers()).find((s) => s.id === 'server-23');
console.log(
  JSON.stringify(
    {
      ok: true,
      tmIp: TM_IP,
      serversUpdated,
      subscriptionsRefreshed: refreshed,
      sampleServer: sample ? { id: sample.id, addressIp: sample.addressIp } : null,
      hint: 'Re-import subscription in Happ',
    },
    null,
    2
  )
);
