#!/usr/bin/env node
import { getBackgroundSyncState } from '../lib/background-sync.js';
import { syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';

const bg = getBackgroundSyncState();
console.log(JSON.stringify({ backgroundSync: bg }, null, 2));

if (process.argv.includes('--run')) {
  const r = await syncVpnEdgeClients();
  console.log(JSON.stringify({
    ok: r.ok,
    message: r.message,
    updated: r.cloudRun?.updated?.length,
    failed: r.cloudRun?.failed,
    skipped: r.cloudRun?.skipped?.length,
  }, null, 2));
}
