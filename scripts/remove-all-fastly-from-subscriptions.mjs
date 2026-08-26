#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listServers, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');

function isFastlyServer(server) {
  const haystack = [
    server?.id,
    server?.service,
    server?.region,
    server?.host,
    server?.sni,
    server?.fastlyDomain,
    server?.fastlyTlsServerName,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes('fastly')
    || haystack.includes('painfully-super-puma.global.ssl.fastly.net')
    || haystack.includes('manage.fastly.com');
}

const [servers, users] = await Promise.all([listServers(10000), listUsers(10000)]);
const fastlyServers = servers.filter(isFastlyServer);
const fastlyIds = new Set(fastlyServers.map((server) => String(server.id)));
if (!fastlyIds.size) throw new Error('No Fastly server records found');

const changes = users.filter((user) => user.uuid).map((user) => {
  const before = {
    bonusServerIds: [...(user.bonusServerIds || [])].map(String),
    pinnedServerIds: [...(user.pinnedServerIds || [])].map(String),
  };
  return {
    user,
    before,
    after: {
      bonusServerIds: before.bonusServerIds.filter((id) => !fastlyIds.has(id)),
      pinnedServerIds: before.pinnedServerIds.filter((id) => !fastlyIds.has(id)),
    },
  };
});

const hiddenServers = fastlyServers.map((server) => ({
  ...server,
  enabled: false,
  subscriptionEligible: false,
  subscriptionHidden: true,
  addToNewClients: false,
  disabledReason: 'removed-from-subscriptions-by-user-request',
  updatedAt: nowIso(),
}));
for (const server of hiddenServers) await upsertServer(server.id, server);

const failures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const assigned = [...change.after.bonusServerIds, ...change.after.pinnedServerIds]
    .filter((id) => fastlyIds.has(id));
  const markers = [
    'manage.fastly.com',
    'painfully-super-puma.global.ssl.fastly.net',
    '@199.232.247.140:443',
    '@199.232.247.142:443',
    '@151.101.1.194:443',
  ].filter((marker) => body.includes(marker));
  if (assigned.length || markers.length) failures.push({ userId: change.user.id, assigned, markers });
}

if (!APPLY || failures.length) {
  for (const server of fastlyServers) await upsertServer(server.id, server);
  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: !APPLY,
    users: changes.length,
    fastlyServerIds: [...fastlyIds],
    assignmentReferencesToRemove: changes.reduce((sum, change) => sum
      + change.before.bonusServerIds.filter((id) => fastlyIds.has(id)).length
      + change.before.pinnedServerIds.filter((id) => fastlyIds.has(id)).length, 0),
    failures: failures.slice(0, 10),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
  process.exit();
}

const timestamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `remove-all-fastly-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  fastlyServers,
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
}, null, 2));

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
    applied.push(change);
  }
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  for (const server of fastlyServers) await upsertServer(server.id, server).catch(() => {});
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  hiddenFastlyServers: [...fastlyIds],
  refreshedSubscriptions: applied.length,
  backupPath,
}, null, 2));
