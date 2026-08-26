#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const APPLY = process.argv.includes('--apply');
const SERVER_ID = 'bunny-fr1-xhttp2-dayanch';
const SOURCE_ID = 'bunny-fr1-current-edge-dayanch';
const EDGE_IP = '94.20.154.22';
const HOST = 'levospeedfr1xhttp2.b-cdn.net';
const XHTTP_PATH = '/media/v4/fr1/sync';

function first(values) {
  const ids = Array.isArray(values) ? values.map(String) : [];
  return [SERVER_ID, ...ids.filter((id) => id !== SERVER_ID)];
}

function plain(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

const [user, source, previous] = await Promise.all([
  getUserById(DAYANCH_VIP_USER_ID),
  getServerById(SOURCE_ID),
  getServerById(SERVER_ID),
]);
if (!user?.uuid) throw new Error('Dayanch VIP not found or UUID is missing');
if (!source || source.enabled === false) throw new Error(`Source server is unavailable: ${SOURCE_ID}`);

const before = {
  bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
  pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
};
const after = {
  bonusServerIds: first(before.bonusServerIds),
  pinnedServerIds: first(before.pinnedServerIds),
};
const timestamp = nowIso();
const server = {
  ...source,
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'France BN XHTTP TEST',
  country: 'France BN XHTTP TEST',
  flag: '🇫🇷',
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  port: 443,
  host: HOST,
  sni: HOST,
  path: XHTTP_PATH,
  network: 'xhttp',
  security: 'tls',
  alpn: 'h2',
  fingerprint: 'chrome',
  xhttpMode: 'auto',
  flow: '',
  rejectUdp443: true,
  finalMask: {
    tcp: [
      {
        type: 'fragment',
        settings: {
          packets: 'tlshello',
          length: '2',
          delay: '0-1',
          maxSplit: '3-6',
        },
      },
    ],
  },
  fragmentation: null,
  enabled: true,
  sortOrder: -5000,
  subscriptionEligible: false,
  subscriptionHidden: false,
  newUsersOnly: true,
  addToNewClients: false,
  allowPinnedRelayOnly: true,
  standalonePilot: true,
  bunnyPullZoneId: 6176525,
  originAddress: '185.209.230.14',
  originPort: 18097,
  createdAt: previous?.createdAt || timestamp,
  updatedAt: timestamp,
};

const previewUser = { ...user, ...after, updatedAt: timestamp };
const expected = [
  `@${EDGE_IP}:443`,
  'type=xhttp',
  `host=${HOST}`,
  `sni=${HOST}`,
  'alpn=h2',
  'mode=auto',
  `path=${encodeURIComponent(XHTTP_PATH)}`,
  'fm=',
];

if (!APPLY) {
  await upsertServer(SERVER_ID, server);
  try {
    const preview = await buildUserSubscriptionBody(previewUser);
    const missing = expected.filter((item) => !preview.includes(item));
    if (missing.length) throw new Error(`Preview is missing: ${missing.join(', ')}`);
  } finally {
    if (previous) await upsertServer(SERVER_ID, previous);
    else await deleteServer(SERVER_ID);
  }
  console.log(JSON.stringify({ ok: true, dryRun: true, user: user.name, serverId: SERVER_ID }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `dayanch-fr1-bunny-xhttp2-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, userId: user.id, before, previous }, null, 2));

let userChanged = false;
try {
  await upsertServer(SERVER_ID, server);
  const preview = await buildUserSubscriptionBody(previewUser);
  const missing = expected.filter((item) => !preview.includes(item));
  if (missing.length) throw new Error(`Preview is missing: ${missing.join(', ')}`);

  await updateUser(user.id, { ...after, updatedAt: timestamp });
  userChanged = true;
  await upsertUserSubscriptionFile(previewUser);

  const stored = plain((await getFileByLinkedUserId(user.id))?.content);
  const storedMissing = expected.filter((item) => !stored.includes(item));
  if (storedMissing.length) throw new Error(`Stored subscription is missing: ${storedMissing.join(', ')}`);

  console.log(JSON.stringify({
    ok: true,
    user: { id: user.id, name: user.name },
    serverId: SERVER_ID,
    edgeIp: EDGE_IP,
    pullZoneId: 6176525,
    pinnedFirst: true,
    backupPath,
  }, null, 2));
} catch (error) {
  if (userChanged) {
    const restored = { ...user, ...before, updatedAt: nowIso() };
    await updateUser(user.id, { ...before, updatedAt: restored.updatedAt }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
  if (previous) await upsertServer(SERVER_ID, previous).catch(() => {});
  else await deleteServer(SERVER_ID).catch(() => {});
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
