#!/usr/bin/env node
import { listServers, listUsers } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { resolveUserServerIds } from '../lib/server-assignment.js';
import { getEnabledServers } from '../lib/db-store.js';

const panel = await getPanelSettings();
const servers = await listServers();
const enabled = await getEnabledServers();

console.log('=== Panel settings ===');
console.log(JSON.stringify({
  connectionMode: panel.connectionMode,
  addressIps: panel.addressIps,
}, null, 2));

console.log('\n=== Servers ===');
for (const s of servers.filter((x) => x.enabled !== false)) {
  console.log(
    `${s.id} | ${s.name} | host=${s.host || '-'} | ip=${s.addressIp || '-'} | cpu=${s.cpu} | mem=${s.memory} | newOnly=${!!s.newUsersOnly}`
  );
}

const sample = (await listUsers()).find((u) => u.status === 'active' && (!u.serverIds || !u.serverIds.length));
if (sample) {
  const body = await buildUserSubscriptionBody(sample);
  const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
  console.log(`\n=== Sample user ${sample.name} (${sample.id}) — ${lines.length} servers in subscription ===`);
  for (const line of lines) {
    const remark = decodeURIComponent((line.split('#')[1] || '').trim());
    const hostMatch = line.match(/@([^:?]+)/);
    console.log(`  ${remark} | connect=${hostMatch?.[1] || '?'}`);
  }
  const assigned = resolveUserServerIds(sample, enabled);
  console.log('Assigned server ids:', assigned.join(', '));
}
