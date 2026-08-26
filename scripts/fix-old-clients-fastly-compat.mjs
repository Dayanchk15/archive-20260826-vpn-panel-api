#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
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
const COMPAT_USER_IDS = new Set([
  'usr_RpKIuuB_9YFGU54F', // Pon
  'usr_bnjXUy4O1NZufeqW', // Dayanch VIP
]);

function dedupe(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function replaceIds(values, removeIds, addIds) {
  const remove = new Set(removeIds);
  return dedupe([...addIds, ...dedupe(values).filter((id) => !remove.has(id))]);
}

const h3Servers = await Promise.all(H3_IDS.map((id) => getServerById(id)));
if (h3Servers.some((server) => !server)) {
  throw new Error('One or more production Fastly H3 server records are missing');
}

const timestamp = nowIso();
const h2Servers = h3Servers.map((server, index) => ({
  ...server,
  id: H2_IDS[index],
  service: H2_IDS[index],
  alpn: 'h2',
  region: 'fastly-tm-h2-compat',
  addToNewClients: false,
  newUsersOnly: true,
  subscriptionHidden: false,
  compatibilityProfile: true,
  compatibilitySourceId: H3_IDS[index],
  createdAt: timestamp,
  updatedAt: timestamp,
}));

const users = (await listUsers(10000)).filter((user) => user.uuid);
const changes = [];
for (const user of users) {
  const before = {
    bonusServerIds: dedupe(user.bonusServerIds),
    pinnedServerIds: dedupe(user.pinnedServerIds),
  };
  const compat = COMPAT_USER_IDS.has(String(user.id));
  const after = compat
    ? {
        bonusServerIds: replaceIds(before.bonusServerIds, H3_IDS, H2_IDS),
        pinnedServerIds: replaceIds(before.pinnedServerIds, H3_IDS, H2_IDS),
      }
    : {
        bonusServerIds: replaceIds(before.bonusServerIds, H2_IDS, H3_IDS),
        pinnedServerIds: replaceIds(before.pinnedServerIds, H2_IDS, H3_IDS),
      };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({ user, before, after, compat });
  }
}

// Preview against temporary server docs, then restore previous records on dry-run.
const previousH2Servers = await Promise.all(H2_IDS.map((id) => getServerById(id)));
for (const server of h2Servers) await upsertServer(server.id, server);

const failures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const expectedAlpn = change.compat ? 'alpn=h2' : 'alpn=h3';
  const count = body.split('@199.232.247.142:443').length - 1;
  if (count < 3 || !body.includes(expectedAlpn)) {
    failures.push({ userId: change.user.id, count, expectedAlpn });
  }
}

if (!APPLY || failures.length) {
  for (let index = 0; index < H2_IDS.length; index += 1) {
    const previous = previousH2Servers[index];
    if (previous) await upsertServer(H2_IDS[index], previous);
    else await deleteServer(H2_IDS[index]);
  }
  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: !APPLY,
    totalUsers: users.length,
    changedUsers: changes.length,
    compatUsers: changes.filter((item) => item.compat).map((item) => item.user.name),
    missingH3Users: changes.filter((item) => !item.compat).length,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
  process.exit();
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `fastly-old-client-compat-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousH2Servers,
  changes: changes.map(({ user, before }) => ({ userId: user.id, name: user.name, before })),
}, null, 2));

for (const change of changes) {
  await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
  await upsertUserSubscriptionFile({ ...change.user, ...change.after });
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  totalUsers: users.length,
  updatedUsers: changes.length,
  compatUsers: changes.filter((item) => item.compat).map((item) => item.user.name),
  addedH3ToUsers: changes.filter((item) => !item.compat).length,
  backupPath,
}, null, 2));
