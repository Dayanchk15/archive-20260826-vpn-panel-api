#!/usr/bin/env node
/**
 * Finalize: 1 warm per region, max=1 everywhere (strict quota).
 * west9 warm: france4 | west4 warm: neth5
 */
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const TM_IP = '216.58.198.50';
const WARM = { 'europe-west9': 'france4', 'europe-west4': 'neth5' };
const WAIT = 40000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

for (const server of servers.sort((a, b) => a.service.localeCompare(b.service))) {
  const warm = WARM[server.region] === server.service;
  const patch = {
    cpu: 1,
    memory: '1Gi',
    addressIp: TM_IP,
    minInstances: warm ? 1 : 0,
    maxInstances: 1,
    updatedAt: nowIso(),
  };
  await updateServer(server.id, patch);
  const r = await applyCloudRunServerPanelState({ ...server, ...patch });
  console.log(
    JSON.stringify({
      service: server.service,
      region: server.region,
      warm,
      min: patch.minInstances,
      max: 1,
      ok: Boolean(r.ok || r.skipped),
      skipped: Boolean(r.skipped),
    })
  );
  await sleep(WAIT);
}

for (const user of await listUsers()) await upsertUserSubscriptionFile(user);

await sleep(90000);

const probes = [];
for (const server of servers.sort((a, b) => a.service.localeCompare(b.service))) {
  await sleep(server.minInstances === 0 ? 5000 : 1000);
  const r = await probeMaskedTlsWithRetry(server, TM_IP, {
    attempts: 2,
    timeoutMs: 25000,
    retryDelayMs: 3000,
  });
  probes.push({ service: server.service, warm: WARM[server.region] === server.service, ok: r.ok, status: r.status, ms: r.ms });
}

console.log(JSON.stringify({ warmByRegion: WARM, probes, bad: probes.filter((p) => !p.ok).map((p) => p.service) }, null, 2));
