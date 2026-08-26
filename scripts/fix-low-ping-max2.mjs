#!/usr/bin/env node
/** min=1 max=2 on all euphoric nodes — warm + headroom for Happ ping + connect. */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const WAIT_MS = Number(process.env.WAIT_MS || 25000);
const REGION_ORDER = ['europe-west4', 'europe-west9', 'europe-west3'];

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

const patch = { cpu: 1, memory: '1Gi', minInstances: 1, maxInstances: 2, updatedAt: nowIso() };
const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

for (const region of REGION_ORDER) {
  for (const server of servers.filter((s) => s.region === region)) {
    await updateServer(server.id, patch);
    const fix = await applyCloudRunServerPanelState({ ...server, ...patch });
    console.log(
      JSON.stringify({
        service: server.service,
        region,
        min: 1,
        max: 2,
        ok: Boolean(fix.ok || fix.skipped),
        message: fix.message || fix.error,
      })
    );
    await sleep(WAIT_MS);
  }
}

await sleep(60000);
const probes = [];
for (const server of servers) {
  const host = String(server.host || '').replace(/^https?:\/\//, '');
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) });
    probes.push({
      service: server.service,
      status: res.status,
      ok: res.status === 400 || res.status === 101 || res.status === 426,
      ms: Date.now() - started,
    });
  } catch (err) {
    probes.push({ service: server.service, ok: false, error: err.message });
  }
}
const bad = probes.filter((p) => !p.ok);
console.log(JSON.stringify({ ok: bad.length === 0, bad: bad.map((b) => b.service), probes }, null, 2));
process.exit(bad.length ? 1 : 0);
