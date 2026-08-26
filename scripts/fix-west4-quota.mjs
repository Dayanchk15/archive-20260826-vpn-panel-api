#!/usr/bin/env node
/**
 * Fix europe-west4 quota: neth6 + poland2 429 / container start timeout.
 * Too many warm services (neth5, neth6, poland2) compete for regional CPU.
 */
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const WAIT_MS = Number(process.env.WAIT_MS || 45000);
const TM_IP = '216.58.198.50';

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function applyService(server, patch) {
  await updateServer(server.id, patch);
  const result = await applyCloudRunServerPanelState({ ...server, ...patch });
  const row = {
    service: server.service,
    region: server.region,
    ...patch,
    ok: Boolean(result.ok || result.skipped),
    message: result.message || result.error,
  };
  console.log(JSON.stringify(row));
  return row;
}

const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);
const west4 = servers.filter((s) => s.region === 'europe-west4');
const byName = (name) => west4.find((s) => s.service === name);

const neth5 = byName('neth5');
const neth6 = byName('neth6');
const poland2 = byName('poland2');

const base = {
  cpu: 1,
  memory: '1Gi',
  addressIp: TM_IP,
  updatedAt: nowIso(),
};

// Step 1: free west4 quota — cold neth6 + poland2
for (const server of [neth6, poland2].filter(Boolean)) {
  await applyService(server, { ...base, minInstances: 0, maxInstances: 1 });
  await sleep(WAIT_MS);
}

// Step 2: warm neth6 (max=1)
if (neth6) {
  await applyService(neth6, { ...base, minInstances: 1, maxInstances: 1 });
  await sleep(WAIT_MS);
}

// Step 3: warm poland2 (max=1)
if (poland2) {
  await applyService(poland2, { ...base, minInstances: 1, maxInstances: 1 });
  await sleep(WAIT_MS);
}

// neth5 stays min=1 max=2
if (neth5) {
  await applyService(neth5, { ...base, minInstances: 1, maxInstances: 2 });
  await sleep(WAIT_MS);
}

await sleep(60000);

const probes = [];
for (const server of west4) {
  const ip = server.addressIp || TM_IP;
  const r = await probeMaskedTlsWithRetry({ ...server, addressIp: ip }, ip, {
    attempts: 2,
    timeoutMs: 15000,
    retryDelayMs: 3000,
  });
  probes.push({ service: server.service, ok: r.ok, status: r.status, ms: r.ms, error: r.error });
}

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const bad = probes.filter((p) => !p.ok);
console.log(
  JSON.stringify({ ok: bad.length === 0, bad: bad.map((b) => b.service), probes, subscriptionsRefreshed: refreshed }, null, 2)
);
process.exit(bad.length ? 1 : 0);
