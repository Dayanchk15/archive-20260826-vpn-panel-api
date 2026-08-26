#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const OLD_IDS = ['pilot-tampa-fastly-xhttp', 'pilot-fornex-fastly-xhttp'];
const NEW_IDS = ['tm-tampa-fastly-h3', 'tm-fornex-fastly-h3', 'tm-fr2-fastly-h3'];
const oldServers = await Promise.all(OLD_IDS.map((id) => getServerById(id)));
if (oldServers.some((server) => !server)) throw new Error('One or more old Fastly servers are missing');

const users = (await listUsers(10000)).filter((user) => user.uuid);
const changes = users.map((user) => {
  const beforeBonus = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const beforePinned = Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [];
  return {
    user,
    before: { bonusServerIds: beforeBonus, pinnedServerIds: beforePinned },
    after: {
      bonusServerIds: beforeBonus.filter((id) => !OLD_IDS.includes(id)),
      pinnedServerIds: beforePinned.filter((id) => !OLD_IDS.includes(id)),
    },
  };
});

for (const server of oldServers) {
  await upsertServer(server.id, {
    ...server,
    enabled: false,
    addToNewClients: false,
    subscriptionHidden: true,
    disabledReason: 'legacy-fastly-not-working-in-tm',
    updatedAt: nowIso(),
  });
}

const failures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const missingNew = NEW_IDS.filter((id) => !change.after.bonusServerIds.includes(id));
  if (body.includes('@151.101.1.194:443')) failures.push({ userId: change.user.id, error: 'old Fastly line remains' });
  if (body.split('@199.232.247.142:443').length - 1 < 3) failures.push({ userId: change.user.id, error: 'working H3 lines missing' });
  if (missingNew.length) failures.push({ userId: change.user.id, error: `assignments missing: ${missingNew.join(',')}` });
}

if (!APPLY || failures.length) {
  for (const server of oldServers) await upsertServer(server.id, server);
  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: !APPLY,
    users: users.length,
    oldIds: OLD_IDS,
    userAssignmentsToRemove: changes.reduce(
      (sum, change) => sum + (change.before.bonusServerIds.length - change.after.bonusServerIds.length) + (change.before.pinnedServerIds.length - change.after.pinnedServerIds.length),
      0
    ),
    failures: failures.slice(0, 5),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
  process.exit();
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `remove-old-fastly-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: nowIso(), oldServers, changes: changes.map(({ user, before }) => ({ userId: user.id, before })) }, null, 2));

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    applied.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
  }
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
  }
  for (const server of oldServers) await upsertServer(server.id, server).catch(() => {});
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  updatedUsers: applied.length,
  removedServerIds: OLD_IDS,
  workingH3ServerIds: NEW_IDS,
  backupPath,
}, null, 2));
