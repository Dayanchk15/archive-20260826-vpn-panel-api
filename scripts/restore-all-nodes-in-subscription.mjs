#!/usr/bin/env node
/** Restore all euphoric nodes in default subscriptions (clear newUsersOnly). */
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const RESTORE_SERVICES = (
  process.env.RESTORE_SERVICES ||
  'uk1,uk2,usa1,usa2,france4,neth6,poland2,germany12'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

const restored = [];
for (const server of servers) {
  if (!RESTORE_SERVICES.includes(server.service) && server.newUsersOnly !== true) continue;
  if (server.newUsersOnly === true || RESTORE_SERVICES.includes(server.service)) {
    await updateServer(server.id, { newUsersOnly: false, updatedAt: nowIso() });
    restored.push(server.service);
  }
}

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const sync = await syncVpnEdgeClientsPhased();

console.log(
  JSON.stringify(
    { ok: true, restored, subscriptionsRefreshed: refreshed, edgeSync: sync },
    null,
    2
  )
);
