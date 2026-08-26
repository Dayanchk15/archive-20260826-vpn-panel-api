#!/usr/bin/env node
/**
 * Remove DNS-TEST 8th line from Dayanch VIP only. Revert germany18 test flags.
 */
import { listServers, listUsers, updateUser, updateServer, getServerById } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const VIP_MATCH = /dayanch\s*vip/i;

const vip = (await listUsers()).find((u) => VIP_MATCH.test(String(u.name || '')));
if (!vip) {
  console.log(JSON.stringify({ ok: false, error: 'Dayanch VIP not found' }));
  process.exit(1);
}

await updateUser(vip.id, {
  bonusServerIds: [],
  updatedAt: nowIso(),
});

const fresh = { ...vip, bonusServerIds: [] };
await upsertUserSubscriptionFile(fresh);

const germany18 = (await listServers()).find((s) => s.service === 'germany18');
if (germany18) {
  await updateServer(germany18.id, {
    minInstances: 0,
    maxInstances: 2,
    xrayDnsSniffTest: false,
    dnsTestNode: false,
    dnsTestLabel: null,
    edgeImageTag: null,
    newUsersOnly: true,
    updatedAt: nowIso(),
  });
  try {
    const g = await getServerById(germany18.id);
    await applyCloudRunServerPanelState({
      ...g,
      minInstances: 0,
      xrayDnsSniffTest: false,
      edgeImageTag: 'latest',
    });
  } catch (err) {
    console.log(JSON.stringify({ germany18ScaleWarn: err.message }));
  }
}

const neth8 = (await listServers()).find((s) => s.service === 'neth8');
if (neth8?.dnsTestNode || neth8?.dnsTestLabel) {
  await updateServer(neth8.id, {
    dnsTestNode: false,
    dnsTestLabel: null,
    updatedAt: nowIso(),
  });
}

const sub = await buildAutoSubscription(fresh);
const lines = sub.split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      ok: true,
      user: { id: vip.id, name: vip.name },
      bonusServerIds: [],
      lineCount: lines.length,
      dnsTestRemoved: true,
      germany18: 'cold, standard image flags',
      otherClientsUnchanged: true,
      happHint: 'Dayanch VIP: обновить подписку — снова 7 серверов.',
    },
    null,
    2
  )
);
