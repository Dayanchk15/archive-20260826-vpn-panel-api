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
const SERVER_ID = 'cloudflare-fr2-finalmask-dayanch';
const EDGE_IP = '8.6.112.0';
const HOST = 'fr2.levospeed.click';
const WS_PATH = '/media/v3/fr2/ws';
const FINAL_MASK = {
  tcp: [{
    type: 'fragment',
    settings: { delay: '1', length: '3', packets: 'tlshello', maxSplit: '5-10' },
  }],
};

function first(values) {
  const current = Array.isArray(values) ? values.map(String) : [];
  return [SERVER_ID, ...current.filter((id) => id !== SERVER_ID)];
}

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function verifyFirst(body, label) {
  const line = String(body).split('\n').find((value) => value.startsWith('vless://')) || '';
  const url = new URL(line);
  const encodedFinalMask = url.searchParams.get('fm');
  if (url.hostname !== EDGE_IP ||
      url.port !== '443' ||
      url.searchParams.get('type') !== 'ws' ||
      url.searchParams.get('host') !== HOST ||
      url.searchParams.get('path') !== WS_PATH ||
      url.searchParams.get('sni') !== HOST ||
      url.searchParams.get('alpn') !== 'http/1.1' ||
      url.searchParams.has('fragment') ||
      url.searchParams.has('xudpProxyUDP443') ||
      !encodedFinalMask ||
      JSON.stringify(JSON.parse(decodeURIComponent(encodedFinalMask))) !== JSON.stringify(FINAL_MASK)) {
    throw new Error(`${label} Cloudflare FinalMask line mismatch`);
  }
  return line;
}

const [users, dayanch, previousServer] = await Promise.all([
  listUsers(10000),
  getUserById(DAYANCH_VIP_USER_ID),
  getServerById(SERVER_ID),
]);
if (!dayanch) throw new Error('Dayanch VIP user not found');

const before = {
  bonusServerIds: Array.isArray(dayanch.bonusServerIds) ? dayanch.bonusServerIds.map(String) : [],
  pinnedServerIds: Array.isArray(dayanch.pinnedServerIds) ? dayanch.pinnedServerIds.map(String) : [],
};
const after = {
  bonusServerIds: first(before.bonusServerIds),
  pinnedServerIds: first(before.pinnedServerIds),
};
const bodiesBefore = new Map();
for (const user of users) bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    user: { id: dayanch.id, name: dayanch.name },
    profile: { id: SERVER_ID, edgeIp: EDGE_IP, host: HOST, path: WS_PATH, finalMask: FINAL_MASK },
    otherUsersToUpdate: 0,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const server = {
  ...(previousServer || {}),
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'France',
  country: 'France',
  flag: '🇫🇷',
  region: 'cloudflare-finalmask',
  sortOrder: -1600,
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
  finalMask: FINAL_MASK,
  rejectUdp443: false,
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
  createdAt: previousServer?.createdAt || timestamp,
  updatedAt: timestamp,
};
const updatedDayanch = { ...dayanch, ...after, updatedAt: timestamp };

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `dayanch-cloudflare-finalmask-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: dayanch.id,
  before,
  previousServer,
}, null, 2), 'utf8');

let serverApplied = false;
let userApplied = false;
async function rollback() {
  if (userApplied) {
    const restored = { ...dayanch, ...before, updatedAt: nowIso() };
    await updateUser(dayanch.id, { ...before, updatedAt: restored.updatedAt }).catch(() => {});
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
  verifyFirst(preview, 'preview');
  const oldConnections = new Set(
    String(bodiesBefore.get(String(dayanch.id)) || '').split('\n')
      .filter((line) => line.startsWith('vless://')).map(connectionPart)
  );
  const newConnections = new Set(
    String(preview).split('\n').filter((line) => line.startsWith('vless://')).map(connectionPart)
  );
  const lost = [...oldConnections].filter((line) => !newConnections.has(line));
  if (lost.length) throw new Error(`Dayanch would lose ${lost.length} existing line(s)`);

  await updateUser(dayanch.id, { ...after, updatedAt: timestamp });
  userApplied = true;
  await upsertUserSubscriptionFile(updatedDayanch);
  verifyFirst(plainContent((await getFileByLinkedUserId(dayanch.id))?.content), 'stored');

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
    serverId: SERVER_ID,
    edgeIp: EDGE_IP,
    host: HOST,
    path: WS_PATH,
    finalMask: FINAL_MASK,
    pinnedFirst: true,
    otherUsersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
