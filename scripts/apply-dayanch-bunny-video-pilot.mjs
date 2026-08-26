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
const SERVER_ID = 'bunny-az-fr2-video-pilot';
const EDGE_IP = '94.20.154.22';
const HOST = 'levospeedfr2.b-cdn.net';
const WS_PATH = '/bunny/fr2?ed=2560';

function first(values, id) {
  const current = Array.isArray(values) ? values.map(String) : [];
  return [id, ...current.filter((value) => value !== id)];
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function plainContent(value) {
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

const previousServer = await getServerById(SERVER_ID);
const originalBonus = Array.isArray(dayanch.bonusServerIds)
  ? dayanch.bonusServerIds.map(String)
  : [];
const originalPinned = Array.isArray(dayanch.pinnedServerIds)
  ? dayanch.pinnedServerIds.map(String)
  : [];
const bodiesBefore = new Map();
for (const user of users) {
  bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));
}

const timestamp = nowIso();
const server = {
  ...(previousServer || {}),
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'France',
  country: 'France',
  flag: '🇫🇷',
  region: 'bunny-az',
  sortOrder: -1400,
  host: HOST,
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  originAddress: '185.209.230.46',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  security: 'tls',
  path: WS_PATH,
  sni: HOST,
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
  rejectUdp443: true,
  createdAt: previousServer?.createdAt || timestamp,
  updatedAt: timestamp,
};
const bonusServerIds = first(originalBonus, SERVER_ID);
const pinnedServerIds = first(originalPinned, SERVER_ID);
const updatedDayanch = {
  ...dayanch,
  bonusServerIds,
  pinnedServerIds,
  updatedAt: timestamp,
};

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    user: { id: dayanch.id, name: dayanch.name },
    server: {
      id: SERVER_ID,
      edgeIp: EDGE_IP,
      host: HOST,
      path: WS_PATH,
      rejectUdp443: true,
    },
    otherUsersToUpdate: 0,
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `dayanch-bunny-video-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: dayanch.id,
  originalBonus,
  originalPinned,
  previousServer,
}, null, 2), 'utf8');

let serverApplied = false;
let userApplied = false;
async function rollback() {
  if (userApplied) {
    const rollbackAt = nowIso();
    const restored = {
      ...dayanch,
      bonusServerIds: originalBonus,
      pinnedServerIds: originalPinned,
      updatedAt: rollbackAt,
    };
    await updateUser(dayanch.id, {
      bonusServerIds: originalBonus,
      pinnedServerIds: originalPinned,
      updatedAt: rollbackAt,
    }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
  if (serverApplied) {
    if (previousServer) await upsertServer(SERVER_ID, previousServer).catch(() => {});
    else await deleteServer(SERVER_ID).catch(() => {});
  }
}

try {
  await upsertServer(SERVER_ID, server);
  serverApplied = true;

  const preview = await buildUserSubscriptionBody(updatedDayanch);
  const lines = preview.split('\n').filter((line) => line.startsWith('vless://'));
  const firstLine = lines[0] || '';
  const expected = [
    `@${EDGE_IP}:443`,
    'type=ws',
    `host=${HOST}`,
    `path=${encodeURIComponent(WS_PATH)}`,
    `sni=${HOST}`,
    'alpn=http%2F1.1',
    'xudpProxyUDP443=reject',
  ];
  const missing = expected.filter((value) => !firstLine.includes(value));
  if (missing.length) throw new Error(`Video pilot preview missing: ${missing.join(', ')}`);

  const oldConnections = new Set(
    String(bodiesBefore.get(String(dayanch.id)) || '')
      .split('\n')
      .filter((line) => line.startsWith('vless://'))
      .map(connectionPart)
  );
  const newConnections = new Set(lines.map(connectionPart));
  const lost = [...oldConnections].filter((line) => !newConnections.has(line));
  if (lost.length) throw new Error(`Dayanch would lose ${lost.length} existing line(s)`);

  await updateUser(dayanch.id, { bonusServerIds, pinnedServerIds, updatedAt: timestamp });
  userApplied = true;
  await upsertUserSubscriptionFile(updatedDayanch);

  const stored = plainContent((await getFileByLinkedUserId(dayanch.id))?.content);
  const storedFirst = stored.split('\n').find((line) => line.startsWith('vless://')) || '';
  for (const value of expected) {
    if (!storedFirst.includes(value)) throw new Error(`Stored pilot missing: ${value}`);
  }

  const changedOtherUsers = [];
  for (const user of users) {
    if (String(user.id) === String(dayanch.id)) continue;
    const after = await buildUserSubscriptionBody(user);
    if (after !== bodiesBefore.get(String(user.id))) changedOtherUsers.push(String(user.id));
  }
  if (changedOtherUsers.length) {
    throw new Error(`Other subscriptions changed: ${changedOtherUsers.join(', ')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    user: { id: dayanch.id, name: dayanch.name },
    serverId: SERVER_ID,
    pinnedFirst: true,
    earlyData: 2560,
    rejectUdp443: true,
    existingConnectionsRemoved: 0,
    otherUsersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
