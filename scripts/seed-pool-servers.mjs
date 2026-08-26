#!/usr/bin/env node
/**
 * Upsert server records from a pool JSON (no Cloud Run deploy).
 * Usage: TM_POOL_JSON=/app/cloud-run-deployer/nodes.euphoric-pool.json node scripts/seed-pool-servers.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_PATH = process.env.TM_POOL_JSON || path.join(__dirname, '..', 'cloud-run-deployer', 'nodes.tm-pool.json');

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
    addressIp: node.addressIp || defaults.addressIp || '216.58.198.46',
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
    cpu: Number(node.cpu ?? defaults.cpu ?? 2),
    memory: node.memory || defaults.memory || '2Gi',
    minInstances: Number(node.minInstances ?? defaults.minInstances ?? 0),
    maxInstances: Number(node.maxInstances ?? defaults.maxInstances ?? 1),
    timeoutSeconds: Number(node.timeoutSeconds ?? defaults.timeoutSeconds ?? 3600),
    tmPool: node.tmPool ?? defaults.tmPool ?? true,
    cloudRunProfileId: node.cloudRunProfileId ?? defaults.cloudRunProfileId ?? null,
  };
}

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
  results.push({ id: node.id, service: node.service, created: !existing });
}

console.log(JSON.stringify({ ok: true, pool: POOL_PATH, total: results.length, results }, null, 2));
