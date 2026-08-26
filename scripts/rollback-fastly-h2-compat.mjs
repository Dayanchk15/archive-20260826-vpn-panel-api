#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const H3_IDS = [
  'tm-tampa-fastly-h3',
  'tm-fornex-fastly-h3',
  'tm-fr2-fastly-h3',
];
const H2_IDS = [
  'tm-tampa-fastly-h2-compat',
  'tm-fornex-fastly-h2-compat',
  'tm-fr2-fastly-h2-compat',
];

function replaceCompatIds(values) {
  const h2 = new Set(H2_IDS);
  return [...new Set([
    ...H3_IDS,
    ...(values || []).map(String).filter((id) => !h2.has(id)),
  ])];
}

const [users, h3Servers, h2Servers] = await Promise.all([
  listUsers(10000),
  Promise.all(H3_IDS.map((id) => getServerById(id))),
  Promise.all(H2_IDS.map((id) => getServerById(id))),
]);
if (h3Servers.some((server) => !server)) throw new Error('Missing production Fastly H3 server');

const changes = users
  .filter((user) => [...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])].some((id) => H2_IDS.includes(String(id))))
  .map((user) => ({
    user,
    before: {
      bonusServerIds: [...(user.bonusServerIds || [])],
      pinnedServerIds: [...(user.pinnedServerIds || [])],
    },
    after: {
      bonusServerIds: replaceCompatIds(user.bonusServerIds),
      pinnedServerIds: replaceCompatIds(user.pinnedServerIds),
    },
  }));

const previewFailures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const addressCount = body.split('@199.232.247.142:443').length - 1;
  if (addressCount < 3 || !body.includes('alpn=h3') || body.includes('alpn=h2')) {
    previewFailures.push({ userId: change.user.id, addressCount });
  }
}
if (previewFailures.length) throw new Error(`H3 preview failed: ${JSON.stringify(previewFailures)}`);

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    changedUsers: changes.map(({ user }) => ({ id: user.id, name: user.name })),
    disableCompatServers: H2_IDS,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `fastly-h2-rollback-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
  h2Servers,
}, null, 2));

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
    applied.push(change);
  }
  for (const server of h2Servers.filter(Boolean)) {
    await upsertServer(server.id, {
      ...server,
      enabled: false,
      subscriptionHidden: true,
      addToNewClients: false,
      updatedAt: nowIso(),
    });
  }
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  for (const server of h2Servers.filter(Boolean)) await upsertServer(server.id, server).catch(() => {});
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  updatedUsers: changes.map(({ user }) => user.name),
  disabledCompatServers: H2_IDS,
  backupPath,
}, null, 2));
