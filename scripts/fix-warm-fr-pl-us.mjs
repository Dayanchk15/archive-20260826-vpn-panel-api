#!/usr/bin/env node
/** Warm only France x2, Poland1, USA x2 — do not touch other nodes. */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const TARGET_SERVICES = new Set(['france3', 'france4', 'poland1', 'usa1', 'usa2']);

const servers = (await listServers()).filter(
  (s) => s.enabled !== false && TARGET_SERVICES.has(String(s.service || '').trim())
);

if (servers.length !== TARGET_SERVICES.size) {
  const found = servers.map((s) => s.service);
  console.error(JSON.stringify({ error: 'expected 5 servers', found }));
  process.exit(1);
}

const results = [];
for (const server of servers) {
  const patch = { minInstances: 1, maxInstances: 2, updatedAt: nowIso() };
  await updateServer(server.id, patch);
  const fresh = { ...server, ...patch };
  try {
    const edge = await applyCloudRunServerPanelState(fresh);
    results.push({
      service: server.service,
      id: server.id,
      ok: edge.ok || edge.skipped,
      message: edge.message || edge.error,
    });
  } catch (err) {
    results.push({ service: server.service, id: server.id, ok: false, error: err.message });
  }
}

await new Promise((r) => setTimeout(r, 30000));

const probes = [];
for (const server of servers) {
  const host = String(server.host || '').replace(/^https?:\/\//, '');
  if (!host) continue;
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    probes.push({
      service: server.service,
      status: res.status,
      alive: res.status === 400 || res.status === 101 || res.status === 426,
      body: body.slice(0, 60),
    });
  } catch (err) {
    probes.push({ service: server.service, error: err.message, alive: false });
  }
}

const failed = results.filter((r) => !r.ok);
const notAlive = probes.filter((p) => !p.alive);
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0 && notAlive.length === 0,
      warmed: results,
      probes,
    },
    null,
    2
  )
);
process.exit(failed.length === 0 && notAlive.length === 0 ? 0 : 1);
