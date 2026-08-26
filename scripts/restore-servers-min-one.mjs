#!/usr/bin/env node
/** Emergency: set minInstances=1 on all enabled servers and reconcile. */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

async function warmHost(host) {
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
      signal: AbortSignal.timeout(30000),
    });
    return { host, ok: res.status === 101 || res.status === 400 || res.status === 426, status: res.status };
  } catch (err) {
    return { host, ok: false, error: err.message || String(err) };
  }
}

async function main() {
  const servers = (await listServers()).filter((s) => s.enabled !== false);
  const results = { updated: [], reconcile: [], warm: [] };

  for (const server of servers) {
    await updateServer(server.id, { minInstances: 1, updatedAt: nowIso() });
    results.updated.push({ id: server.id, service: server.service });
  }

  for (const server of servers) {
    const fresh = { ...server, minInstances: 1 };
    const edge = await applyCloudRunServerPanelState(fresh);
    results.reconcile.push({
      id: server.id,
      service: server.service,
      ok: edge.ok,
      minInstances: edge.scaling?.minInstances,
    });
    if (server.host) {
      results.warm.push(await warmHost(server.host));
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
