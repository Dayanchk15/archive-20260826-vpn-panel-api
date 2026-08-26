#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const H3_IDS = [
  'tm-tampa-fastly-h3',
  'tm-fornex-fastly-h3',
  'tm-fr2-fastly-h3',
];
const H2_IDS = [
  'tm-tampa-fastly-h2-compat',
  'tm-fornex-fastly-h2-compat',
  'tm-fr2-fastly-h2-compat',
];

function addIds(values, ids) {
  return [...new Set([...(values || []).map(String), ...ids])];
}

const timestamp = nowIso();
const [users, h3Servers, previousH2Servers] = await Promise.all([
  listUsers(10000),
  Promise.all(H3_IDS.map((id) => getServerById(id))),
  Promise.all(H2_IDS.map((id) => getServerById(id))),
]);
if (h3Servers.some((server) => !server)) throw new Error('Missing production Fastly H3 server');

const h2Servers = h3Servers.map((server, index) => ({
  ...server,
  ...(previousH2Servers[index] || {}),
  id: H2_IDS[index],
  service: H2_IDS[index],
  name: server.name,
  country: server.country,
  flag: server.flag,
  addressIp: server.addressIp,
  addressIps: [...(server.addressIps || [server.addressIp])],
  fastlyAddress: server.fastlyAddress || server.addressIp,
  host: server.host,
  sni: server.sni,
  path: server.path,
  network: 'xhttp',
  security: 'tls',
  port: 443,
  alpn: 'h2',
  xhttpMode: server.xhttpMode || 'auto',
  region: 'fastly-tm-h2-compat',
  enabled: true,
  subscriptionEligible: true,
  subscriptionHidden: false,
  addToNewClients: false,
  newUsersOnly: false,
  compatibilityProfile: true,
  compatibilitySourceId: H3_IDS[index],
  createdAt: previousH2Servers[index]?.createdAt || timestamp,
  updatedAt: timestamp,
}));

const changes = users.filter((user) => user.uuid).map((user) => ({
  user,
  before: {
    bonusServerIds: [...(user.bonusServerIds || [])],
    pinnedServerIds: [...(user.pinnedServerIds || [])],
  },
  after: {
    bonusServerIds: addIds(user.bonusServerIds, H2_IDS),
    pinnedServerIds: addIds(user.pinnedServerIds, H2_IDS),
  },
}));

for (const server of h2Servers) await upsertServer(server.id, server);

const failures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const h2Count = body.split('alpn=h2').length - 1;
  const h3Count = body.split('alpn=h3').length - 1;
  if (h2Count < 3 || h3Count < 3) {
    failures.push({ userId: change.user.id, h2Count, h3Count });
  }
}

if (!APPLY || failures.length) {
  for (let index = 0; index < H2_IDS.length; index += 1) {
    const previous = previousH2Servers[index];
    if (previous) await upsertServer(H2_IDS[index], previous);
  }
  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: !APPLY,
    users: changes.length,
    h2Servers: H2_IDS,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
  process.exit();
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `fastly-h2-all-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousH2Servers,
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
}, null, 2));

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
    applied.push(change);
  }
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  for (let index = 0; index < H2_IDS.length; index += 1) {
    const previous = previousH2Servers[index];
    if (previous) await upsertServer(H2_IDS[index], previous).catch(() => {});
  }
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  enabledServers: H2_IDS,
  refreshedSubscriptions: applied.length,
  userAssignmentsRemoved: 0,
  backupPath,
}, null, 2));
