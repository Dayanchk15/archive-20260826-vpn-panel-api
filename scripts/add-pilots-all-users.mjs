#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, updateUser } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const PILOT_IDS = ['pilot-tampa-reality', 'pilot-fornex-reality', 'pilot-fr1-tcp'];
const PILOT_ADDRESSES = ['74.115.172.101:9443', '130.17.12.61:443', '185.209.230.14:18443'];
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');

function unionPilotFirst(values) {
  return [...new Set([...PILOT_IDS, ...(Array.isArray(values) ? values.map(String) : [])])];
}

for (const id of PILOT_IDS) {
  const server = await getServerById(id);
  if (!server || server.enabled !== true || server.standalonePilot !== true) {
    throw new Error(`Pilot is not safely enabled: ${id}`);
  }
}

const users = (await listUsers()).filter((user) => user.uuid);
const changes = users.map((user) => ({
  id: user.id,
  name: user.name || '',
  before: {
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds : [],
  },
  after: {
    bonusServerIds: unionPilotFirst(user.bonusServerIds),
    pinnedServerIds: unionPilotFirst(user.pinnedServerIds),
  },
}));

const previewFailures = [];
for (const user of users) {
  const change = changes.find((item) => item.id === user.id);
  const body = await buildUserSubscriptionBody({ ...user, ...change.after });
  const missing = PILOT_ADDRESSES.filter((address) => !body.includes(`@${address}`));
  if (missing.length) previewFailures.push({ userId: user.id, missing });
}
if (previewFailures.length) {
  throw new Error(`Dry-run subscription verification failed for ${previewFailures.length} user(s)`);
}

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, users: users.length, pilots: PILOT_IDS, previewFailures: 0 }, null, 2));
  process.exit(0);
}

await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `add-pilots-all-users-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: nowIso(), pilots: PILOT_IDS, changes }, null, 2), 'utf8');

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.id, { ...change.after, updatedAt: nowIso() });
    applied.push(change);
  }
  for (const user of users) {
    await upsertUserSubscriptionFile({ ...user, ...changes.find((item) => item.id === user.id).after });
  }
} catch (err) {
  for (const change of applied.reverse()) {
    await updateUser(change.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    const original = users.find((user) => user.id === change.id);
    if (original) {
      await upsertUserSubscriptionFile({ ...original, ...change.before }).catch(() => {});
    }
  }
  throw err;
}

const finalUsers = await listUsers();
const failed = [];
for (const user of finalUsers.filter((item) => item.uuid)) {
  const body = await buildUserSubscriptionBody(user);
  const missing = PILOT_ADDRESSES.filter((address) => !body.includes(`@${address}`));
  if (missing.length) failed.push({ userId: user.id, missing });
}
if (failed.length) throw new Error(`Post-apply verification failed for ${failed.length} user(s); backup: ${backupPath}`);

console.log(JSON.stringify({ ok: true, dryRun: false, updated: applied.length, verified: finalUsers.length, backupPath }, null, 2));
