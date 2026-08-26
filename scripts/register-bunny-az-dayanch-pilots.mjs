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
} from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { DAYANCH_VIP_USER_ID } from '../lib/vip-users.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const EDGE_IP = '94.20.154.22';
const definitions = [
  {
    id: 'bunny-az-fr2-pilot',
    name: 'France',
    country: 'France',
    flag: '🇫🇷',
    host: 'levospeedfr2.b-cdn.net',
    path: '/bunny/fr2',
    originAddress: '185.209.230.46',
    sortOrder: -1300,
  },
  {
    id: 'bunny-az-fornex-pilot',
    name: 'Germany',
    country: 'Germany',
    flag: '🇩🇪',
    host: 'levospeedfornex.b-cdn.net',
    path: '/assets/v3/sync',
    originAddress: '130.17.12.61',
    sortOrder: -1299,
  },
  {
    id: 'bunny-az-tampa-pilot',
    name: 'USA',
    country: 'USA',
    flag: '🇺🇸',
    host: 'levospeedtampa.b-cdn.net',
    path: '/bunny/tampa',
    originAddress: '74.115.172.101',
    sortOrder: -1298,
  },
];
const pilotIds = definitions.map((item) => item.id);

function idsFirst(values) {
  const current = Array.isArray(values) ? values.map(String) : [];
  return [...pilotIds, ...current.filter((id) => !pilotIds.includes(id))];
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function plainSubscriptionContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const users = await listUsers(10000);
const dayanch = await getUserById(DAYANCH_VIP_USER_ID);
if (!dayanch) throw new Error('Dayanch VIP user not found');

const originalBonus = Array.isArray(dayanch.bonusServerIds) ? dayanch.bonusServerIds.map(String) : [];
const originalPinned = Array.isArray(dayanch.pinnedServerIds) ? dayanch.pinnedServerIds.map(String) : [];
const beforeBodies = new Map();
for (const user of users) {
  beforeBodies.set(String(user.id), await buildUserSubscriptionBody(user));
}
const previousServers = new Map();
for (const definition of definitions) {
  previousServers.set(definition.id, await getServerById(definition.id));
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    user: { id: dayanch.id, name: dayanch.name },
    edgeIp: EDGE_IP,
    pilots: definitions.map(({ id, host, path, originAddress }) => ({ id, host, path, originAddress })),
    otherUsersToUpdate: 0,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const serverDocs = definitions.map((definition) => {
  const existing = previousServers.get(definition.id);
  return {
    ...(existing || {}),
    ...definition,
    service: definition.id,
    region: 'bunny-az',
    addressIp: EDGE_IP,
    addressIps: [EDGE_IP],
    forceAddressIp: true,
    port: 443,
    protocol: 'vless',
    network: 'ws',
    security: 'tls',
    sni: definition.host,
    alpn: 'http/1.1',
    fingerprint: 'chrome',
    flow: '',
    enabled: true,
    externalVps: true,
    standalonePilot: true,
    relayPilot: false,
    subscriptionEligible: false,
    subscriptionHidden: false,
    newUsersOnly: true,
    addToNewClients: false,
    allowPinnedRelayOnly: true,
    minInstances: 1,
    maxInstances: 1,
    rejectUdp443: false,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
});
const bonusServerIds = idsFirst(originalBonus);
const pinnedServerIds = idsFirst(originalPinned);
const updatedDayanch = {
  ...dayanch,
  bonusServerIds,
  pinnedServerIds,
  updatedAt: timestamp,
};

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `bunny-az-dayanch-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: dayanch.id,
  originalBonus,
  originalPinned,
  previousServers: Object.fromEntries(previousServers),
}, null, 2), 'utf8');

let serversApplied = false;
let userApplied = false;
async function rollback() {
  if (userApplied) {
    await updateUser(dayanch.id, {
      bonusServerIds: originalBonus,
      pinnedServerIds: originalPinned,
      updatedAt: nowIso(),
    }).catch(() => {});
    await upsertUserSubscriptionFile({
      ...dayanch,
      bonusServerIds: originalBonus,
      pinnedServerIds: originalPinned,
      updatedAt: nowIso(),
    }).catch(() => {});
  }
  if (serversApplied) {
    for (const definition of definitions) {
      const previous = previousServers.get(definition.id);
      if (previous) await upsertServer(definition.id, previous).catch(() => {});
      else await deleteServer(definition.id).catch(() => {});
    }
  }
}

try {
  for (const server of serverDocs) await upsertServer(server.id, server);
  serversApplied = true;

  const previewBody = await buildUserSubscriptionBody(updatedDayanch);
  const previewLines = previewBody.split('\n').filter((line) => line.startsWith('vless://'));
  for (const [index, definition] of definitions.entries()) {
    const line = previewLines[index] || '';
    const expected = [
      `@${EDGE_IP}:443`,
      'type=ws',
      `host=${definition.host}`,
      `path=${encodeURIComponent(definition.path)}`,
      `sni=${definition.host}`,
      'alpn=http%2F1.1',
    ];
    const missing = expected.filter((value) => !line.includes(value));
    if (missing.length) throw new Error(`${definition.id} preview missing: ${missing.join(', ')}`);
  }
  const oldConnections = new Set(
    String(beforeBodies.get(String(dayanch.id)) || '').split('\n').filter(Boolean).map(connectionPart)
  );
  const newConnections = new Set(previewLines.map(connectionPart));
  const lostConnections = [...oldConnections].filter((line) => !newConnections.has(line));
  if (lostConnections.length) throw new Error(`Dayanch would lose ${lostConnections.length} existing line(s)`);

  await updateUser(dayanch.id, { bonusServerIds, pinnedServerIds, updatedAt: timestamp });
  userApplied = true;
  await upsertUserSubscriptionFile(updatedDayanch);

  const stored = await getFileByLinkedUserId(dayanch.id);
  const storedBody = plainSubscriptionContent(stored?.content);
  for (const definition of definitions) {
    if (!storedBody.includes(`@${EDGE_IP}:443`) || !storedBody.includes(`host=${definition.host}`)) {
      throw new Error(`Stored subscription is missing ${definition.id}`);
    }
  }

  const changedOtherUsers = [];
  for (const user of users) {
    if (String(user.id) === String(dayanch.id)) continue;
    const after = await buildUserSubscriptionBody(user);
    if (after !== beforeBodies.get(String(user.id))) changedOtherUsers.push(String(user.id));
  }
  if (changedOtherUsers.length) {
    throw new Error(`Other subscriptions changed: ${changedOtherUsers.join(', ')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    user: { id: dayanch.id, name: dayanch.name },
    edgeIp: EDGE_IP,
    pilots: pilotIds,
    pinnedFirst: true,
    storedSubscriptionUpdated: true,
    existingConnectionsRemoved: 0,
    otherUsersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
