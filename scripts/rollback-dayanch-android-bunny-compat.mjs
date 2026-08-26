#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  deleteServer,
  getServerById,
  getUserById,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';
import { nowIso } from '/app/lib/dates.js';

const BACKUP = '/data/files/backups/dayanch-android-bunny-2026-07-17T01-29-37-608Z.json';
const compatIds = [
  'bunny-android-fr2-dayanch',
  'bunny-android-fornex-dayanch',
  'bunny-android-tampa-dayanch',
];
const expected = [
  { host: 'levospeedfr2.b-cdn.net', path: '/bunny/fr2?ed=2560' },
  { host: 'levospeedfornex.b-cdn.net', path: '/assets/v3/sync?ed=2560' },
  { host: 'levospeedtampa.b-cdn.net', path: '/bunny/tampa?ed=2560' },
];

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function verifyFirstThree(body, label) {
  const lines = String(body).split('\n').filter((line) => line.startsWith('vless://'));
  for (const [index, item] of expected.entries()) {
    const url = new URL(lines[index] || '');
    if (url.hostname !== '94.20.154.22' ||
        url.searchParams.get('host') !== item.host ||
        url.searchParams.get('path') !== item.path ||
        url.searchParams.get('xudpProxyUDP443') !== 'reject') {
      throw new Error(`${label} line ${index + 1} does not match previous Bunny profile`);
    }
  }
}

const backup = JSON.parse(await readFile(BACKUP, 'utf8'));
const user = await getUserById(DAYANCH_VIP_USER_ID);
if (!user) throw new Error('Dayanch VIP user not found');
const currentCompatServers = new Map();
for (const id of compatIds) currentCompatServers.set(id, await getServerById(id));

const restoredAt = nowIso();
const restoredUser = { ...user, ...backup.before, updatedAt: restoredAt };
try {
  for (const id of compatIds) {
    const previous = backup.previousServers?.[id];
    if (previous) await upsertServer(id, previous);
    else await deleteServer(id);
  }
  await updateUser(user.id, { ...backup.before, updatedAt: restoredAt });
  await upsertUserSubscriptionFile(restoredUser);

  verifyFirstThree(await buildUserSubscriptionBody(restoredUser), 'generated');
  const stored = plainContent((await getFileByLinkedUserId(user.id))?.content);
  verifyFirstThree(stored, 'stored');

  console.log(JSON.stringify({
    ok: true,
    user: user.name,
    restoredFrom: BACKUP,
    androidCompatProfilesRemoved: compatIds,
    previousBunnyProfilesRestored: true,
  }, null, 2));
} catch (error) {
  for (const [id, server] of currentCompatServers) {
    if (server) await upsertServer(id, server).catch(() => {});
  }
  await updateUser(user.id, {
    serverIds: user.serverIds || [],
    bonusServerIds: user.bonusServerIds || [],
    pinnedServerIds: user.pinnedServerIds || [],
    updatedAt: nowIso(),
  }).catch(() => {});
  await upsertUserSubscriptionFile(user).catch(() => {});
  throw new Error(`${error.message}; rollback of rollback completed`);
}
