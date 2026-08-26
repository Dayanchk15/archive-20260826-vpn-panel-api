#!/usr/bin/env node
/** Full UUID sync for all users on all enabled euphoric nodes. */
import { listUsers } from '../lib/db-store.js';
import { syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';
import { getEnabledServerIds } from '../lib/db-store.js';

const serverIds = await getEnabledServerIds({ forNewUser: true });
console.log(JSON.stringify({ phase: 'start', serverIds, userCount: (await listUsers()).length }));

const sync = await syncVpnEdgeClients({
  serverIds,
  timeoutMs: 0,
  serverTimeoutMs: Number(process.env.VPN_EDGE_SYNC_SERVER_TIMEOUT_MS || 120000),
});

console.log(
  JSON.stringify(
    {
      ok: sync.ok,
      updated: sync.cloudRun?.updated?.map((e) => e.service),
      failed: sync.cloudRun?.failed,
      skipped: sync.cloudRun?.skipped?.map((e) => e.service),
      message: sync.message,
    },
    null,
    2
  )
);
process.exit(sync.cloudRun?.failed?.length ? 1 : 0);
