#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { applyRelayUserDefaults } from '/app/lib/relay-subscription.js';

const APPLY = process.argv.includes('--apply');
const IDS = [
  'cloudflare-finalmask-tampa-dayanch',
  'cloudflare-finalmask-fr1-dayanch',
  'cloudflare-finalmask-fornex-dayanch',
  'cloudflare-fr2-finalmask-dayanch',
];
const HOSTS = [
  'tampa.levospeed.click',
  'fr1.levospeed.click',
  'fornex.levospeed.click',
  'fr2.levospeed.click',
];

function first(values) {
  const current = (Array.isArray(values) ? values : []).map(String);
  const selected = new Set(IDS);
  return [...IDS, ...current.filter((id) => !selected.has(id))];
}

function links(body) {
  return String(body || '').split(/\r?\n/).filter((line) => line.startsWith('vless://'));
}

function connection(line) {
  return String(line || '').split('#')[0];
}

function verify(body) {
  const all = links(body);
  for (let index = 0; index < HOSTS.length; index += 1) {
    const host = HOSTS[index];
    const line = all[index] || '';
    if (!line.includes(`host=${host}`) || !line.includes('?fm=')) {
      throw new Error(`Cloudflare ${host} is not at position ${index + 1}`);
    }
    const parsed = new URL(line);
    if (
      parsed.hostname !== '8.6.112.0' || parsed.port !== '443' ||
      parsed.searchParams.get('type') !== 'ws' ||
      parsed.searchParams.get('host') !== host ||
      parsed.searchParams.get('sni') !== host
    ) throw new Error(`Cloudflare ${host} link mismatch`);
  }
  return all;
}

const [users, servers] = await Promise.all([
  listUsers(10000),
  Promise.all(IDS.map((id) => getServerById(id))),
]);
const missing = IDS.filter((_, index) => !servers[index]);
if (missing.length) throw new Error(`Missing Cloudflare servers: ${missing.join(', ')}`);
const eligibleUsers = users.filter((user) => user.uuid);

const changes = [];
for (const user of eligibleUsers) {
  const before = {
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
  };
  changes.push({
    user,
    before,
    after: { bonusServerIds: first(before.bonusServerIds), pinnedServerIds: first(before.pinnedServerIds) },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true, dryRun: true, usersToUpdate: changes.length, addAndPinFirst: IDS,
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `cloudflare-finalmask-all-users-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  servers,
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
}, null, 2), 'utf8');

let serversApplied = 0;
const applied = [];
async function rollback() {
  for (const change of [...applied].reverse()) {
    const restored = { ...change.user, ...change.before, updatedAt: new Date().toISOString() };
    await updateUser(change.user.id, { ...change.before, updatedAt: restored.updatedAt }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
  for (let index = 0; index < serversApplied; index += 1) {
    await upsertServer(IDS[index], servers[index]).catch(() => {});
  }
}

try {
  for (let index = 0; index < IDS.length; index += 1) {
    await upsertServer(IDS[index], {
      ...servers[index],
      enabled: true,
      subscriptionEligible: true,
      subscriptionHidden: false,
      newUsersOnly: false,
      addToNewClients: true,
      allowPinnedRelayOnly: true,
      updatedAt: timestamp,
    });
    serversApplied += 1;
  }

  for (const change of changes) {
    const preview = await buildUserSubscriptionBody({ ...change.user, ...change.after });
    const next = verify(preview);
    const oldConnections = new Set(links(change.oldBody).map(connection));
    const nextConnections = new Set(next.map(connection));
    const lost = [...oldConnections].filter((item) => !nextConnections.has(item));
    if (lost.length) throw new Error(`${change.user.id} would lose ${lost.length} existing profile(s)`);
  }

  const future = await applyRelayUserDefaults({
    id: 'future-cloudflare-finalmask-probe',
    uuid: '00000000-0000-4000-8000-000000000001',
    status: 'active',
  });
  if (!IDS.every((id) => future.bonusServerIds?.map(String).includes(id))) {
    throw new Error('Future clients would miss Cloudflare profiles');
  }

  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: timestamp });
    applied.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after, updatedAt: timestamp });
  }

  console.log(JSON.stringify({
    ok: true,
    usersUpdated: applied.length,
    subscriptionsRefreshed: applied.length,
    pinnedFirst: IDS,
    futureClientsAutoAssigned: true,
    unrelatedProfilesRemoved: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
