#!/usr/bin/env node
/**
 * Fix Happ timeouts: restore 1 CPU / 1Gi, max=2, warm primary EU nodes.
 */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const WARM_SERVICES = new Set(
  (process.env.WARM_SERVICES || 'germany8,germany9,france3,poland1,usa1,usa2')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const servers = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

const updates = [];
for (const server of servers) {
  const warm = WARM_SERVICES.has(server.service);
  const patch = {
    cpu: 1,
    memory: '1Gi',
    maxInstances: 2,
    minInstances: warm ? 1 : 0,
    updatedAt: nowIso(),
  };
  await updateServer(server.id, patch);
  updates.push({ service: server.service, warm, patch });
}

const reconcile = [];
for (const server of servers) {
  const warm = WARM_SERVICES.has(server.service);
  const fresh = {
    ...server,
    cpu: 1,
    memory: '1Gi',
    maxInstances: 2,
    minInstances: warm ? 1 : 0,
  };
  try {
    const edge = await applyCloudRunServerPanelState(fresh);
    reconcile.push({
      service: server.service,
      warm,
      ok: edge.ok || edge.skipped,
      message: edge.message || edge.error,
    });
  } catch (err) {
    reconcile.push({ service: server.service, warm, ok: false, message: err.message });
  }
}

console.log(JSON.stringify({ action: 'waiting-warm', seconds: 35 }));
await new Promise((r) => setTimeout(r, 35000));

const probes = [];
for (const server of servers) {
  const host = String(server.host || '').replace(/^https?:\/\//, '');
  if (!host) continue;
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) });
    const ok = res.status === 400 || res.status === 101 || res.status === 426;
    probes.push({
      service: server.service,
      status: res.status,
      ok,
      ms: Date.now() - started,
    });
  } catch (err) {
    probes.push({
      service: server.service,
      ok: false,
      error: err.message,
      ms: Date.now() - started,
    });
  }
}

const sync = await syncVpnEdgeClientsPhased();
const failed = reconcile.filter((r) => !r.ok);
const badProbes = probes.filter((p) => !p.ok);

console.log(
  JSON.stringify(
    {
      ok: failed.length === 0 && badProbes.length === 0,
      warmServices: [...WARM_SERVICES],
      reconcileFailed: failed,
      probeFailed: badProbes,
      probes,
      edgeSyncOk: sync.ok,
    },
    null,
    2
  )
);
process.exit(failed.length === 0 && badProbes.length === 0 ? 0 : 1);
