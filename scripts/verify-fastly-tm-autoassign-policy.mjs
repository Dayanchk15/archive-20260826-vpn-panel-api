#!/usr/bin/env node
import { getServerById } from '../lib/db-store.js';
import { listEnabledRelayServerIds } from '../lib/relay-subscription.js';

const ids = ['tm-tampa-fastly-h3', 'tm-fornex-fastly-h3', 'tm-fr2-fastly-h3'];
const autoIds = new Set(await listEnabledRelayServerIds({ tmShardOrder: true }));
const servers = await Promise.all(ids.map((id) => getServerById(id)));
const failures = [];
for (let index = 0; index < ids.length; index += 1) {
  const id = ids[index];
  const server = servers[index];
  if (!server) failures.push(`${id}:missing`);
  if (server?.addToNewClients !== false) failures.push(`${id}:auto-add-enabled`);
  if (server?.subscriptionEligible !== true) failures.push(`${id}:assigned-ineligible`);
  if (autoIds.has(id)) failures.push(`${id}:present-in-auto-pool`);
}
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: ids.length, autoAssigned: 0, assignedEligible: ids.length }, null, 2));
