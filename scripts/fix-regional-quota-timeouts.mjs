#!/usr/bin/env node
/**
 * Fix regional CPU quota (europe-west4) + stable timeouts:
 * - west3 DE: min=1 max=2
 * - west9 FR/PL/US: min=1 max=2 on primary
 * - west4: min=0 max=2 (cold, avoids quota)
 */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const WARM_WEST3 = new Set(['germany8', 'germany9', 'germany10', 'germany11']);
const WARM_WEST9 = new Set(['france3', 'france4', 'poland1', 'usa1', 'usa2']);

function plan(server) {
  const region = server.region || '';
  const service = server.service;
  const patch = { cpu: 1, memory: '1Gi', maxInstances: 2, updatedAt: nowIso() };

  if (region === 'europe-west3' && WARM_WEST3.has(service)) {
    patch.minInstances = 1;
    return { ...patch, tier: 'warm-west3' };
  }
  if (region === 'europe-west9' && WARM_WEST9.has(service)) {
    patch.minInstances = 1;
    return { ...patch, tier: 'warm-west9' };
  }
  patch.minInstances = 0;
  return { ...patch, tier: 'cold' };
}

const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

// Phase 1: scale down europe-west4 first (free quota)
const west4 = servers.filter((s) => s.region === 'europe-west4');
for (const server of west4) {
  const patch = plan(server);
  await updateServer(server.id, patch);
  const fresh = { ...server, ...patch };
  const fix = await applyCloudRunServerPanelState(fresh);
  console.log(JSON.stringify({ phase: 1, service: server.service, ok: fix.ok || fix.skipped }));
}

await new Promise((r) => setTimeout(r, 20000));

// Phase 2: rest
for (const server of servers.filter((s) => s.region !== 'europe-west4')) {
  const patch = plan(server);
  await updateServer(server.id, patch);
  const fresh = { ...server, ...patch };
  const fix = await applyCloudRunServerPanelState(fresh);
  console.log(JSON.stringify({ phase: 2, service: server.service, ok: fix.ok || fix.skipped }));
}

await new Promise((r) => setTimeout(r, 30000));

const probes = [];
for (const server of servers) {
  const host = String(server.host || '').replace(/^https?:\/\//, '');
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) });
    const ok = res.status === 400 || res.status === 101 || res.status === 426;
    probes.push({ service: server.service, region: server.region, status: res.status, ok });
  } catch (err) {
    probes.push({ service: server.service, region: server.region, ok: false, error: err.message });
  }
}

const sync = await syncVpnEdgeClientsPhased();
const bad = probes.filter((p) => !p.ok);
console.log(
  JSON.stringify(
    {
      ok: bad.length === 0,
      warmWest3: [...WARM_WEST3],
      warmWest9: [...WARM_WEST9],
      coldWest4: west4.map((s) => s.service),
      bad: bad.map((b) => b.service),
      probes,
      edgeSyncOk: sync.ok,
    },
    null,
    2
  )
);
