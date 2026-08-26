#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, upsertServer } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const APPLY = process.argv.includes('--apply');
const TARGETS = [
  ['bunny-az-fr2-pilot', 'BN'],
  ['bunny-az-fornex-pilot', 'BN'],
  ['bunny-az-tampa-pilot', 'BN'],
  ['cloudflare-finalmask-tampa-dayanch', 'CF'],
  ['cloudflare-finalmask-fr1-dayanch', 'CF'],
  ['cloudflare-finalmask-fornex-dayanch', 'CF'],
  ['cloudflare-fr2-finalmask-dayanch', 'CF'],
];

function withSuffix(value, suffix) {
  const base = String(value || 'Server').trim().replace(/\s+(BN|CF)$/i, '');
  return `${base} ${suffix}`;
}

function connections(body) {
  return String(body || '').split(/\r?\n/)
    .filter((line) => line.startsWith('vless://'))
    .map((line) => line.split('#')[0]);
}

const [users, servers] = await Promise.all([
  listUsers(10000),
  Promise.all(TARGETS.map(([id]) => getServerById(id))),
]);
const missing = TARGETS.filter((_, index) => !servers[index]).map(([id]) => id);
if (missing.length) throw new Error(`Missing target servers: ${missing.join(', ')}`);

const bodiesBefore = new Map();
for (const user of users) bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));
const changes = TARGETS.map(([id, suffix], index) => ({
  id,
  from: servers[index].country,
  to: withSuffix(servers[index].country, suffix),
}));

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, changes, usersToRefresh: users.length }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `cdn-label-suffixes-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, servers }, null, 2), 'utf8');

let applied = 0;
async function rollback() {
  for (let index = 0; index < applied; index += 1) {
    await upsertServer(TARGETS[index][0], servers[index]).catch(() => {});
  }
  for (const user of users) await upsertUserSubscriptionFile(user).catch(() => {});
}

try {
  for (let index = 0; index < TARGETS.length; index += 1) {
    const [id, suffix] = TARGETS[index];
    const server = servers[index];
    await upsertServer(id, {
      ...server,
      country: withSuffix(server.country, suffix),
      name: withSuffix(server.name || server.country, suffix),
      updatedAt: timestamp,
    });
    applied += 1;
  }

  const bodiesAfter = new Map();
  for (const user of users) {
    const after = await buildUserSubscriptionBody(user);
    bodiesAfter.set(String(user.id), after);
    if (JSON.stringify(connections(after)) !== JSON.stringify(connections(bodiesBefore.get(String(user.id))))) {
      throw new Error(`Connection parameters changed for user ${user.id}`);
    }
  }
  for (const user of users) await upsertUserSubscriptionFile(user);

  console.log(JSON.stringify({
    ok: true,
    changes,
    usersRefreshed: users.length,
    connectionParametersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
