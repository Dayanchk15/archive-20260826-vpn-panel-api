#!/usr/bin/env node
/**
 * Order only the DADA mobile profile. Happ sortOrder and subscriptions stay unchanged.
 * The first three entries deliberately span Bunny plus two independent VPS origins.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.env.APPLY === '1';
const TARGETS = [
  ['bunny-fr1-current-edge-dayanch', -3000],
  ['cloudflare-fr2-finalmask-dayanch', -2999],
  ['cloudflare-finalmask-fornex-dayanch', -2998],
  ['cloudflare-finalmask-fr1-dayanch', -2900],
  ['cloudflare-finalmask-tampa-dayanch', -2800],
];

const current = [];
for (const [id, mobilePriority] of TARGETS) {
  const server = await getServerById(id);
  if (!server) throw new Error(`Missing CDN server: ${id}`);
  if (server.enabled === false || server.mobileEnabled !== true || server.mobileMaintenance === true) {
    throw new Error(`CDN server is not eligible for mobile traffic: ${id}`);
  }
  current.push({ id, server, previous: server.mobilePriority ?? server.sortOrder, mobilePriority });
}

const plan = current.map(({ id, previous, mobilePriority }) => ({ id, previous, mobilePriority }));
if (!APPLY) {
  console.log(JSON.stringify({ dryRun: true, changes: plan }, null, 2));
  process.exit(0);
}

const backupDir = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupDir, { recursive: true });
const stamp = nowIso().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `mobile-cdn-priority-${stamp}.json`);
await writeFile(
  backupPath,
  JSON.stringify({ createdAt: nowIso(), servers: current.map(({ server }) => server) }, null, 2),
  { encoding: 'utf8', mode: 0o600 },
);

for (const { id, mobilePriority } of current) {
  await upsertServer(id, { mobilePriority, updatedAt: nowIso() });
}

const verified = [];
for (const [id, mobilePriority] of TARGETS) {
  const server = await getServerById(id);
  if (Number(server?.mobilePriority) !== mobilePriority) {
    throw new Error(`Priority verification failed for ${id}`);
  }
  verified.push({ id, mobilePriority });
}

console.log(JSON.stringify({ ok: true, backupPath, verified }, null, 2));
