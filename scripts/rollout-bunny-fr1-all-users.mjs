#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { applyRelayUserDefaults } from '/app/lib/relay-subscription.js';

const APPLY = process.argv.includes('--apply');
const ID = 'bunny-az-fr1-pilot';
const BUNNY_IDS = ['bunny-az-fr2-pilot', 'bunny-az-fornex-pilot', 'bunny-az-tampa-pilot'];
const HOST = 'levospeedfr1xhttp.b-cdn.net';
const WS_PATH = '/media/v3/fr1/ws?ed=2560';
const EDGE_IP = '94.20.154.22';

function insertAfterBunny(values) {
  const current = (Array.isArray(values) ? values : []).map(String).filter((id) => id !== ID);
  let position = -1;
  for (let index = 0; index < current.length; index += 1) {
    if (BUNNY_IDS.includes(current[index])) position = index;
  }
  if (position < 0) return [ID, ...current];
  return [...current.slice(0, position + 1), ID, ...current.slice(position + 1)];
}

function links(body) {
  return String(body || '').split(/\r?\n/).filter((line) => line.startsWith('vless://'));
}

function connection(line) {
  return String(line || '').split('#')[0];
}

function verify(body) {
  const matching = links(body).filter((line) => line.includes(`host=${HOST}`));
  if (matching.length !== 1) throw new Error(`expected one FR1 Bunny link, found ${matching.length}`);
  const parsed = new URL(matching[0]);
  if (
    parsed.hostname !== EDGE_IP || parsed.port !== '443' ||
    parsed.searchParams.get('type') !== 'ws' ||
    parsed.searchParams.get('host') !== HOST ||
    parsed.searchParams.get('path') !== WS_PATH ||
    parsed.searchParams.get('sni') !== HOST ||
    parsed.searchParams.get('alpn') !== 'http/1.1'
  ) throw new Error('FR1 Bunny link mismatch');
  return matching[0];
}

const [users, previousServer] = await Promise.all([
  listUsers(10000),
  getServerById(ID),
]);
const eligibleUsers = users.filter((user) => user.uuid);
if (!eligibleUsers.length) throw new Error('No users with UUID');

const changes = [];
for (const user of eligibleUsers) {
  const before = {
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
  };
  changes.push({
    user,
    before,
    after: {
      bonusServerIds: insertAfterBunny(before.bonusServerIds),
      pinnedServerIds: insertAfterBunny(before.pinnedServerIds),
    },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true, dryRun: true, id: ID, host: HOST, path: WS_PATH,
    usersToUpdate: changes.length, existingServer: Boolean(previousServer),
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString();
const server = {
  ...(previousServer || {}),
  id: ID,
  service: ID,
  name: 'France BN',
  country: 'France BN',
  flag: '🇫🇷',
  region: 'bunny-az',
  sortOrder: -1297,
  host: HOST,
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  originAddress: '185.209.230.14',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  security: 'tls',
  path: WS_PATH,
  sni: HOST,
  alpn: 'http/1.1',
  fingerprint: 'chrome',
  flow: '',
  rejectUdp443: true,
  enabled: true,
  externalVps: true,
  standalonePilot: false,
  relayPilot: false,
  subscriptionEligible: true,
  subscriptionHidden: false,
  newUsersOnly: false,
  addToNewClients: true,
  allowPinnedRelayOnly: true,
  minInstances: 1,
  maxInstances: 1,
  createdAt: previousServer?.createdAt || timestamp,
  updatedAt: timestamp,
};

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `bunny-fr1-all-users-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousServer,
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
}, null, 2), 'utf8');

let serverApplied = false;
const applied = [];
async function rollback() {
  for (const change of [...applied].reverse()) {
    const restored = { ...change.user, ...change.before, updatedAt: new Date().toISOString() };
    await updateUser(change.user.id, { ...change.before, updatedAt: restored.updatedAt }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
  if (serverApplied) {
    if (previousServer) await upsertServer(ID, previousServer).catch(() => {});
    else await deleteServer(ID).catch(() => {});
  }
}

try {
  await upsertServer(ID, server);
  serverApplied = true;

  for (const change of changes) {
    const preview = await buildUserSubscriptionBody({ ...change.user, ...change.after });
    verify(preview);
    const oldConnections = new Set(links(change.oldBody).map(connection));
    const nextConnections = new Set(links(preview).map(connection));
    const lost = [...oldConnections].filter((item) => !nextConnections.has(item));
    if (lost.length) throw new Error(`${change.user.id} would lose ${lost.length} existing profile(s)`);
  }

  const future = await applyRelayUserDefaults({
    id: 'future-bunny-fr1-probe',
    uuid: '00000000-0000-4000-8000-000000000001',
    status: 'active',
  });
  if (!future.bonusServerIds?.map(String).includes(ID)) throw new Error('Future clients would miss FR1 Bunny');

  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: timestamp });
    applied.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after, updatedAt: timestamp });
  }

  console.log(JSON.stringify({
    ok: true,
    id: ID,
    host: HOST,
    usersUpdated: applied.length,
    subscriptionsRefreshed: applied.length,
    futureClientsAutoAssigned: true,
    unrelatedProfilesRemoved: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
