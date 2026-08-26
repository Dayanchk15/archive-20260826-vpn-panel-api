#!/usr/bin/env node
/** Warm neth6 after neth5 max=1 to fit europe-west4 CPU quota. */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const TM_IP = '216.58.198.50';
const WAIT = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = await listServers();
const neth5 = servers.find((s) => s.service === 'neth5');
const neth6 = servers.find((s) => s.service === 'neth6');
const base = { cpu: 1, memory: '1Gi', addressIp: TM_IP, updatedAt: nowIso() };

for (const [server, patch] of [
  [neth5, { ...base, minInstances: 1, maxInstances: 1 }],
  [neth6, { ...base, minInstances: 0, maxInstances: 1 }],
]) {
  await updateServer(server.id, patch);
  console.log(JSON.stringify({ step: 'apply', service: server.service, patch, result: await applyCloudRunServerPanelState({ ...server, ...patch }) }));
  await sleep(WAIT);
}

await updateServer(neth6.id, { ...base, minInstances: 1, maxInstances: 1, updatedAt: nowIso() });
console.log(JSON.stringify({ step: 'warm-neth6', result: await applyCloudRunServerPanelState({ ...neth6, ...base, minInstances: 1, maxInstances: 1 }) }));
await sleep(60000);

for (const server of [neth5, neth6]) {
  const r = await probeMaskedTlsWithRetry(server, TM_IP, { attempts: 2, timeoutMs: 15000 });
  console.log(JSON.stringify({ service: server.service, ok: r.ok, status: r.status, ms: r.ms }));
}
