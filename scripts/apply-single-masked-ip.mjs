#!/usr/bin/env node
/**
 * Apply a single masked IP to all servers and panel for consistency.
 * One IP = no rotation confusion, easy to probe and verify.
 */
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const IP = process.env.IP || '216.58.198.50';

const panel = await getPanelSettings();
console.log(JSON.stringify({ before: panel.addressIps, connectionMode: panel.connectionMode }));

await updatePanelSettings({ addressIps: [IP], connectionMode: 'masked' });

const servers = (await listServers()).filter(
  s => s.enabled !== false && s.cloudRunProfileId === 'gcp-euphoric'
);

for (const s of servers) {
  await updateServer(s.id, { addressIp: IP, updatedAt: nowIso() });
}

const users = await listUsers();
let n = 0;
for (const u of users) { await upsertUserSubscriptionFile(u); n++; }

console.log(JSON.stringify({ done: true, ip: IP, connectionMode: 'masked', servers: servers.length, subscriptions: n }));
