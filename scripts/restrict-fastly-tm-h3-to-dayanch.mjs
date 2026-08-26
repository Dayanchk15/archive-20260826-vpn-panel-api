#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const SERVER_IDS = ['tm-tampa-fastly-h3', 'tm-fornex-fastly-h3'];
const normalize = (value) => String(value || '').trim().toLowerCase();
const displayName = (user) => user.name || user.username || user.displayName || user.telegramUsername || '';
const users = (await listUsers(10000)).filter((user) => user.uuid);
const candidates = users.filter((user) => {
  const value = normalize(displayName(user));
  return value.includes('dayanch') && value.includes('vip');
});

if (candidates.length !== 1) {
  throw new Error(`Expected exactly one Dayanch VIP, found ${candidates.length}: ${JSON.stringify(candidates.map((u) => ({ id: u.id, name: displayName(u) })))}`);
}
const vip = candidates[0];

const changes = users.map((user) => {
  const beforeBonus = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const beforePinned = Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [];
  const isVip = user.id === vip.id;
  const afterBonus = isVip
    ? [...new Set([...SERVER_IDS, ...beforeBonus])]
    : beforeBonus.filter((id) => !SERVER_IDS.includes(id));
  const afterPinned = isVip
    ? [...new Set([...SERVER_IDS, ...beforePinned])]
    : beforePinned.filter((id) => !SERVER_IDS.includes(id));
  return {
    id: user.id,
    user,
    isVip,
    before: { bonusServerIds: beforeBonus, pinnedServerIds: beforePinned },
    after: { bonusServerIds: afterBonus, pinnedServerIds: afterPinned },
    changed: JSON.stringify([beforeBonus, beforePinned]) !== JSON.stringify([afterBonus, afterPinned]),
  };
});

const summary = {
  ok: true,
  dryRun: !APPLY,
  vip: { id: vip.id, name: displayName(vip) },
  totalUsers: users.length,
  usersChanged: changes.filter((item) => item.changed).length,
  removedFromUsers: changes.filter((item) => !item.isVip && item.changed).length,
  serverIds: SERVER_IDS,
};
if (!APPLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `restrict-fastly-tm-h3-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const serverBackups = [];
for (const serverId of SERVER_IDS) serverBackups.push(await getServerById(serverId));
await writeFile(
  backupPath,
  JSON.stringify({ createdAt: timestamp, vip: summary.vip, serverBackups, changes: changes.map(({ id, before }) => ({ id, before })) }, null, 2),
  'utf8'
);

for (const server of serverBackups) {
  if (!server) throw new Error('TM Fastly H3 server is missing');
  await upsertServer(server.id, {
    ...server,
    addToNewClients: false,
    allowPinnedRelayOnly: true,
    updatedAt: timestamp,
  });
}

const applied = [];
try {
  for (const change of changes.filter((item) => item.changed)) {
    await updateUser(change.id, { ...change.after, updatedAt: nowIso() });
    applied.push(change);
  }
  for (const change of changes.filter((item) => item.changed)) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
  }
  const vipChange = changes.find((item) => item.isVip);
  await upsertUserSubscriptionFile({ ...vipChange.user, ...vipChange.after });
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  for (const server of serverBackups) {
    if (server) await upsertServer(server.id, server).catch(() => {});
  }
  throw error;
}

const finalUsers = (await listUsers(10000)).filter((user) => user.uuid);
const failures = finalUsers.filter((user) => {
  const ids = new Set([
    ...(Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : []),
    ...(Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : []),
  ]);
  const hasBoth = SERVER_IDS.every((id) => ids.has(id));
  const hasAny = SERVER_IDS.some((id) => ids.has(id));
  return user.id === vip.id ? !hasBoth : hasAny;
});
if (failures.length) throw new Error(`Restriction verification failed for ${failures.length} user(s)`);

const bodyFailures = [];
for (const user of finalUsers) {
  const body = await buildUserSubscriptionBody(user);
  const tmLineCount = body
    .split('\n')
    .filter((line) => line.includes('@199.232.247.142:443') && line.includes('sni=manage.fastly.com') && line.includes('alpn=h3') && line.includes('mode=auto'))
    .length;
  const expectedCount = user.id === vip.id ? 2 : 0;
  if (tmLineCount !== expectedCount) bodyFailures.push({ userId: user.id, tmLineCount, expectedCount });
}
if (bodyFailures.length) throw new Error(`Subscription body verification failed: ${JSON.stringify(bodyFailures.slice(0, 3))}`);

console.log(JSON.stringify({ ...summary, dryRun: false, backupPath, verified: finalUsers.length, vipTmLineCount: 2, otherUsersTmLineCount: 0 }, null, 2));
