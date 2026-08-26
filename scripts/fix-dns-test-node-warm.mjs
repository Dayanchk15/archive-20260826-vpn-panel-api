#!/usr/bin/env node
/**
 * Fix DNS-TEST (germany18) timeouts: warm min=1 + fastest VIP Google IP on node.
 * Only touches germany18 — not the 7-server pool.
 */
import { listServers, getServerById, updateServer, listUsers } from '../lib/db-store.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { probeServerReachability } from '../lib/node-reachability-probe.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';

const SERVICE = 'germany18';
const FAST_VIP_IP = '216.58.198.50';

const servers = await listServers();
const server = servers.find((s) => s.service === SERVICE);
if (!server) {
  console.log(JSON.stringify({ ok: false, error: 'germany18 not found' }));
  process.exit(1);
}

await updateServer(server.id, {
  minInstances: 1,
  maxInstances: 2,
  cpu: 2,
  memory: '2Gi',
  addressIp: FAST_VIP_IP,
  updatedAt: nowIso(),
});

const fresh = await getServerById(server.id);
console.log(JSON.stringify({ phase: 'deploy', service: fresh.service, minInstances: 1, addressIp: FAST_VIP_IP }));
const deploy = await applyCloudRunServerPanelState(fresh);
console.log(JSON.stringify({ phase: 'deployDone', deploy }));

await new Promise((r) => setTimeout(r, 20000));

const sync = await syncVpnEdgeClientsPhased({ serverIds: [fresh.id], maxParallel: 1 });
console.log(JSON.stringify({ phase: 'syncDone', ok: sync.ok }));

const vip = (await listUsers()).find((u) => /dayanch\s*vip/i.test(String(u.name || '')));
if (vip) {
  await upsertUserSubscriptionFile(vip);
  const sub = await buildAutoSubscription(vip);
  const lines = sub.split('\n').filter((l) => l.startsWith('vless://'));
  const last = lines[lines.length - 1];
  console.log(
    JSON.stringify({
      phase: 'vipRefresh',
      lineCount: lines.length,
      dnsTestIp: last?.match(/@([^:]+):/)?.[1],
      dnsTestHost: last ? new URL(last).searchParams.get('host') : null,
    })
  );
}

const probe = await probeMaskedTlsWithRetry(fresh, FAST_VIP_IP, {
  attempts: 2,
  retryDelayMs: 5000,
  timeoutMs: 25000,
});
const reach = await probeServerReachability(fresh, { timeoutMs: 25000 });

console.log(
  JSON.stringify(
    {
      ok: probe.ok && reach.ok,
      service: SERVICE,
      warm: true,
      probe,
      reach,
      note: 'Dayanch: обновить подписку. DNS-TEST теперь warm + IP 216.58.198.50',
    },
    null,
    2
  )
);

process.exit(probe.ok && reach.ok ? 0 : 1);
