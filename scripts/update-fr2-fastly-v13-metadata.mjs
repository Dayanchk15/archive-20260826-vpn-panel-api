#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const SERVER_ID = 'tm-fr2-fastly-h3';
const expected = {
  host: 'painfully-super-puma.global.ssl.fastly.net',
  path: '/fr2/',
  addressIp: '199.232.247.142',
};

const before = await getServerById(SERVER_ID);
if (!before) throw new Error(`${SERVER_ID} not found`);
for (const [key, value] of Object.entries(expected)) {
  if (before[key] !== value) {
    throw new Error(`${SERVER_ID}.${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(before[key])}`);
  }
}

const after = {
  ...before,
  fastlyServiceId: 'jTVEqzhBxwkuQI8L0iWoDQ',
  fastlyActiveVersion: 13,
  fastlyOriginPort: 18444,
  fastlyRuntimePort: 18445,
  fastlyBackendName: 'Host 1',
  fastlyZeroDisconnectRedirect: true,
  updatedAt: nowIso(),
};

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, serverId: SERVER_ID, before: {
    host: before.host,
    path: before.path,
    addressIp: before.addressIp,
    fastlyActiveVersion: before.fastlyActiveVersion,
  }, after: {
    host: after.host,
    path: after.path,
    addressIp: after.addressIp,
    fastlyActiveVersion: after.fastlyActiveVersion,
    fastlyRuntimePort: after.fastlyRuntimePort,
  } }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `fr2-fastly-v13-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: nowIso(), serverId: SERVER_ID, before }, null, 2), 'utf8');
await upsertServer(SERVER_ID, after);

const saved = await getServerById(SERVER_ID);
if (saved?.fastlyActiveVersion !== 13 || saved?.host !== expected.host || saved?.path !== expected.path) {
  await upsertServer(SERVER_ID, before);
  throw new Error('FR2 metadata verification failed; original document restored');
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  serverId: SERVER_ID,
  fastlyActiveVersion: saved.fastlyActiveVersion,
  fastlyRuntimePort: saved.fastlyRuntimePort,
  assignmentsChanged: 0,
  subscriptionsChanged: 0,
  backupPath,
}, null, 2));
