#!/usr/bin/env node
/**
 * Fix TM connection timeouts: rotated Google IPs, warm nodes, refresh subs, edge sync.
 * Run: docker exec vpn-panel-api-vps node scripts/fix-tm-timeouts.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { getServerById, listServers, upsertServer } from '../lib/db-store.js';
import { listUsers } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClientsPhased } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_PATH = process.env.TM_POOL_JSON || path.join(__dirname, '..', 'cloud-run-deployer', 'nodes.euphoric-pool.json');

function loadPool() {
  const parsed = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
  return { defaults: parsed.defaults || {}, nodes: parsed.nodes || [] };
}

function buildServerRecord(node, defaults) {
  return {
    id: node.id,
    name: node.name,
    country: node.country || '',
    flag: node.flag || '',
    host: node.host || '',
    service: node.service,
    cloudRunService: node.service,
    region: node.region,
    cloudRunRegion: node.region,
    addressIp: node.addressIp || defaults.addressIp || '172.217.16.142',
    port: 443,
    network: 'ws',
    security: 'tls',
    path: '/',
    sni: 'www.google.com',
    fingerprint: 'chrome',
    alpn: 'http/1.1',
    enabled: true,
    remark: node.remark || '',
    sortOrder: Number(node.sortOrder || 0),
    cpu: Number(node.cpu ?? defaults.cpu ?? 1),
    memory: node.memory || defaults.memory || '1Gi',
    minInstances: Number(node.minInstances ?? defaults.minInstances ?? 0),
    maxInstances: Number(node.maxInstances ?? defaults.maxInstances ?? 1),
    timeoutSeconds: Number(node.timeoutSeconds ?? defaults.timeoutSeconds ?? 3600),
    tmPool: node.tmPool ?? defaults.tmPool ?? true,
    cloudRunProfileId: node.cloudRunProfileId ?? defaults.cloudRunProfileId ?? null,
  };
}

async function seedFromPool() {
  const { defaults, nodes } = loadPool();
  const now = nowIso();
  const results = [];
  for (const node of nodes) {
    const existing = await getServerById(node.id);
    const record = buildServerRecord(node, defaults);
    await upsertServer(node.id, {
      ...record,
      host: existing?.host || record.host,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    results.push({ id: node.id, service: node.service, addressIp: record.addressIp, minInstances: record.minInstances });
  }
  return { total: results.length, results };
}

const panel = await getPanelSettings();
await updatePanelSettings({
  ...panel,
  connectionMode: 'masked',
  importUrlMode: 'api',
  subscriptionBaseUrl: 'https://sub.twidu.com',
  infoRowHost: 'www.google.com',
  infoRowPort: 80,
  preferGcsDirectUrl: false,
  addressIps: ['216.58.198.46'],
  updatedAt: nowIso(),
});

const seed = await seedFromPool();

const euphoric = (await listServers()).filter(
  (s) => s.cloudRunProfileId === 'gcp-euphoric' && s.enabled !== false
);

const reconcile = [];
for (const server of euphoric) {
  try {
    const fix = await applyCloudRunServerPanelState(server);
    reconcile.push({
      id: server.id,
      service: server.service,
      ok: fix.ok || fix.skipped,
      minInstances: server.minInstances,
      addressIp: server.addressIp,
      message: fix.message || fix.error,
    });
  } catch (err) {
    reconcile.push({ id: server.id, ok: false, message: err.message });
  }
}

const edgeSync = await syncVpnEdgeClientsPhased({ serverIds: euphoric.map((s) => s.id) });

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      panel: { connectionMode: 'masked', subscriptionBaseUrl: 'https://sub.twidu.com' },
      seed,
      warmNodes: euphoric.filter((s) => Number(s.minInstances) >= 1).map((s) => s.service),
      reconcileOk: reconcile.filter((r) => r.ok).length,
      reconcileFailed: reconcile.filter((r) => !r.ok),
      edgeSync: { ok: edgeSync.ok, message: edgeSync.message },
      subscriptionsRefreshed: refreshed,
      hint: 'Clients must re-import subscription in Happ to get new IPs and server order',
    },
    null,
    2
  )
);
