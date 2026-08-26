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
const SERVER_ID = 'bunny-fr1-current-edge-dayanch';
const SOURCE_ID = 'bunny-az-fr1-pilot';
const EDGE_IP = '37.19.203.178';
const HOST = 'levospeedfr1xhttp.b-cdn.net';
const WS_PATH = '/media/v3/fr1/ws?ed=2560';

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
if (!user) throw new Error('Dayanch VIP not found');
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
  name: 'France BN TEST',
  country: 'France BN TEST',
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  host: HOST,
  sni: HOST,
  path: WS_PATH,
  network: 'ws',
  security: 'tls',
  alpn: 'http/1.1',
  fingerprint: 'chrome',
  rejectUdp443: false,
  finalMask: null,
  enabled: true,
  sortOrder: -2000,
  subscriptionEligible: false,
  subscriptionHidden: false,
  newUsersOnly: true,
  addToNewClients: false,
  allowPinnedRelayOnly: true,
  standalonePilot: true,
  createdAt: previous?.createdAt || timestamp,
  updatedAt: timestamp,
};

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, user: user.name, serverId: SERVER_ID, edgeIp: EDGE_IP }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `dayanch-bunny-current-edge-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, userId: user.id, before, previous }, null, 2));

let userChanged = false;
try {
  await upsertServer(SERVER_ID, server);
  const previewUser = { ...user, ...after, updatedAt: timestamp };
  const preview = await buildUserSubscriptionBody(previewUser);
  const line = preview.split(/\r?\n/).find((item) => item.includes(`@${EDGE_IP}:443`));
  if (!line) throw new Error('New edge line is missing from preview');
  const url = new URL(line);
  if (url.searchParams.get('host') !== HOST || url.searchParams.get('path') !== WS_PATH) {
    throw new Error('New edge line parameters do not match');
  }

  await updateUser(user.id, { ...after, updatedAt: timestamp });
  userChanged = true;
  await upsertUserSubscriptionFile(previewUser);
  const stored = plain((await getFileByLinkedUserId(user.id))?.content);
  if (!stored.includes(`@${EDGE_IP}:443`) || !stored.includes(`host=${HOST}`)) {
    throw new Error('Stored subscription does not contain the new test edge');
  }

  console.log(JSON.stringify({
    ok: true,
    user: { id: user.id, name: user.name },
    serverId: SERVER_ID,
    edgeIp: EDGE_IP,
    pinnedFirst: true,
    existingServersRemoved: 0,
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
