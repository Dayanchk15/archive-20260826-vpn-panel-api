#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  getUserById,
  listUsers,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const definitions = [
  {
    id: 'bunny-android-fr2-dayanch', sourceId: 'bunny-az-fr2-pilot',
    host: 'levospeedfr2.b-cdn.net', path: '/bunny/fr2', sortOrder: -1500,
  },
  {
    id: 'bunny-android-fornex-dayanch', sourceId: 'bunny-az-fornex-pilot',
    host: 'levospeedfornex.b-cdn.net', path: '/assets/v3/sync', sortOrder: -1499,
  },
  {
    id: 'bunny-android-tampa-dayanch', sourceId: 'bunny-az-tampa-pilot',
    host: 'levospeedtampa.b-cdn.net', path: '/bunny/tampa', sortOrder: -1498,
  },
];
const sourceIds = new Set(definitions.map((item) => item.sourceId));
const compatIds = definitions.map((item) => item.id);
const targetHosts = new Set(definitions.map((item) => item.host));

function compatFirst(values) {
  const current = Array.isArray(values) ? values.map(String) : [];
  return [
    ...compatIds,
    ...current.filter((id) => !sourceIds.has(id) && !compatIds.includes(id)),
  ];
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function vlessLines(body) {
  return String(body || '').split('\n').filter((line) => line.startsWith('vless://'));
}

function hostOf(line) {
  try { return new URL(line).searchParams.get('host') || ''; } catch { return ''; }
}

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

const [users, dayanch] = await Promise.all([
  listUsers(10000),
  getUserById(DAYANCH_VIP_USER_ID),
]);
if (!dayanch) throw new Error('Dayanch VIP user not found');

const previousServers = new Map();
const sourceServers = new Map();
for (const definition of definitions) {
  previousServers.set(definition.id, await getServerById(definition.id));
  const source = await getServerById(definition.sourceId);
  if (!source || source.enabled === false) throw new Error(`Source server missing: ${definition.sourceId}`);
  sourceServers.set(definition.sourceId, source);
}

const before = {
  serverIds: Array.isArray(dayanch.serverIds) ? dayanch.serverIds.map(String) : [],
  bonusServerIds: Array.isArray(dayanch.bonusServerIds) ? dayanch.bonusServerIds.map(String) : [],
  pinnedServerIds: Array.isArray(dayanch.pinnedServerIds) ? dayanch.pinnedServerIds.map(String) : [],
};
const after = {
  serverIds: before.serverIds.filter((id) => !sourceIds.has(id) && !compatIds.includes(id)),
  bonusServerIds: compatFirst(before.bonusServerIds),
  pinnedServerIds: compatFirst(before.pinnedServerIds),
};
const bodiesBefore = new Map();
for (const user of users) bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    user: { id: dayanch.id, name: dayanch.name },
    profiles: definitions.map(({ id, host, path }) => ({ id, host, path })),
    earlyData: false,
    rejectUdp443: false,
    otherUsersToUpdate: 0,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const serverDocs = definitions.map((definition) => {
  const source = sourceServers.get(definition.sourceId);
  const existing = previousServers.get(definition.id);
  return {
    ...source,
    ...(existing || {}),
    id: definition.id,
    service: definition.id,
    path: definition.path,
    sortOrder: definition.sortOrder,
    rejectUdp443: false,
    enabled: true,
    standalonePilot: true,
    subscriptionEligible: false,
    subscriptionHidden: false,
    newUsersOnly: true,
    addToNewClients: false,
    allowPinnedRelayOnly: true,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
});
const updatedDayanch = { ...dayanch, ...after, updatedAt: timestamp };

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `dayanch-android-bunny-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: dayanch.id,
  before,
  previousServers: Object.fromEntries(previousServers),
}, null, 2), 'utf8');

let serversApplied = false;
let userApplied = false;
async function rollback() {
  for (const [id, previous] of previousServers) {
    if (previous) await upsertServer(id, previous).catch(() => {});
    else await deleteServer(id).catch(() => {});
  }
  if (userApplied) {
    const restored = { ...dayanch, ...before, updatedAt: nowIso() };
    await updateUser(dayanch.id, { ...before, updatedAt: restored.updatedAt }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
}

try {
  for (const server of serverDocs) await upsertServer(server.id, server);
  serversApplied = true;

  const preview = await buildUserSubscriptionBody(updatedDayanch);
  const previewLines = vlessLines(preview);
  for (const [index, definition] of definitions.entries()) {
    const line = previewLines[index] || '';
    const url = new URL(line);
    if (url.hostname !== '94.20.154.22' ||
        url.searchParams.get('host') !== definition.host ||
        url.searchParams.get('path') !== definition.path ||
        url.searchParams.has('xudpProxyUDP443')) {
      throw new Error(`Compatibility preview mismatch: ${definition.id}`);
    }
  }
  const oldUnrelated = vlessLines(bodiesBefore.get(String(dayanch.id)))
    .filter((line) => !targetHosts.has(hostOf(line)))
    .map(connectionPart);
  const newConnections = new Set(previewLines.map(connectionPart));
  const lost = oldUnrelated.filter((line) => !newConnections.has(line));
  if (lost.length) throw new Error(`Dayanch would lose ${lost.length} unrelated line(s)`);

  await updateUser(dayanch.id, { ...after, updatedAt: timestamp });
  userApplied = true;
  await upsertUserSubscriptionFile(updatedDayanch);

  const stored = plainContent((await getFileByLinkedUserId(dayanch.id))?.content);
  const storedLines = vlessLines(stored);
  for (const [index, definition] of definitions.entries()) {
    const url = new URL(storedLines[index] || '');
    if (url.searchParams.get('host') !== definition.host ||
        url.searchParams.get('path') !== definition.path ||
        url.searchParams.has('xudpProxyUDP443')) {
      throw new Error(`Stored compatibility mismatch: ${definition.id}`);
    }
  }

  const changedOthers = [];
  for (const user of users) {
    if (String(user.id) === String(dayanch.id)) continue;
    if (await buildUserSubscriptionBody(user) !== bodiesBefore.get(String(user.id))) {
      changedOthers.push(String(user.id));
    }
  }
  if (changedOthers.length) throw new Error(`Other subscriptions changed: ${changedOthers.length}`);

  console.log(JSON.stringify({
    ok: true,
    user: { id: dayanch.id, name: dayanch.name },
    profiles: compatIds,
    pinnedFirst: true,
    earlyData: false,
    rejectUdp443: false,
    otherUsersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  if (serversApplied || userApplied) await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
