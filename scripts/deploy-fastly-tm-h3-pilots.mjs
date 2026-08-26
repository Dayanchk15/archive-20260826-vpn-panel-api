#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const FASTLY_ADDRESS = '199.232.247.142';
const TLS_SERVER_NAME = 'manage.fastly.com';
const XHTTP_HOST = 'painfully-super-puma.global.ssl.fastly.net';
const SERVICE_ID = 'jTVEqzhBxwkuQI8L0iWoDQ';
const SERVER_IDS = ['tm-tampa-fastly-h3', 'tm-fornex-fastly-h3', 'tm-fr2-fastly-h3'];
const timestamp = nowIso();

const definitions = [
  {
    id: SERVER_IDS[0],
    name: 'США',
    country: 'США',
    flag: '🇺🇸',
    sortOrder: -340,
    path: '/tampa/',
    originAddress: '74.115.172.101',
  },
  {
    id: SERVER_IDS[1],
    name: 'Германия',
    country: 'Германия',
    flag: '🇩🇪',
    sortOrder: -339,
    path: '/fornex/',
    originAddress: '130.17.12.61',
  },
  {
    id: SERVER_IDS[2],
    name: 'Франция',
    country: 'Франция',
    flag: '🇫🇷',
    sortOrder: -338,
    path: '/fr2/',
    originAddress: '185.209.230.46',
  },
];

const serverDocs = [];
for (const definition of definitions) {
  const existing = await getServerById(definition.id);
  serverDocs.push({
    ...existing,
    ...definition,
    service: definition.id,
    region: 'fastly-tm-h3',
    host: XHTTP_HOST,
    addressIp: FASTLY_ADDRESS,
    addressIps: [FASTLY_ADDRESS],
    forceAddressIp: true,
    port: 443,
    protocol: 'vless',
    network: 'xhttp',
    security: 'tls',
    sni: TLS_SERVER_NAME,
    fingerprint: 'chrome',
    alpn: 'h3',
    xhttpMode: 'auto',
    flow: '',
    enabled: true,
    externalVps: true,
    standalonePilot: true,
    relayPilot: false,
    newUsersOnly: false,
    subscriptionHidden: false,
    addToNewClients: false,
    subscriptionEligible: true,
    minInstances: 1,
    maxInstances: 1,
    fastlyServiceId: SERVICE_ID,
    fastlyDomain: XHTTP_HOST,
    fastlyAddress: FASTLY_ADDRESS,
    fastlyTlsServerName: TLS_SERVER_NAME,
    fastlyActiveVersion: 9,
    updatedAt: timestamp,
    createdAt: existing?.createdAt || timestamp,
  });
}

const users = (await listUsers(10000)).filter((user) => user.uuid);
const changes = [];
for (const user of users) {
  const beforeBonus = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const beforePinned = Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [];
  const afterBonus = [...new Set([...SERVER_IDS, ...beforeBonus])];
  const afterPinned = [...new Set([...SERVER_IDS, ...beforePinned])];
  changes.push({
    id: user.id,
    user,
    before: { bonusServerIds: beforeBonus, pinnedServerIds: beforePinned },
    after: { bonusServerIds: afterBonus, pinnedServerIds: afterPinned },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

for (const server of serverDocs) await upsertServer(server.id, server);

const expected = [
  'type=xhttp',
  `host=${XHTTP_HOST}`,
  `sni=${TLS_SERVER_NAME}`,
  'alpn=h3',
  'mode=auto',
  `@${FASTLY_ADDRESS}:443`,
];
const previewFailures = [];
for (const change of changes) {
  const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
  const missing = expected.filter((value) => !body.includes(value));
  if (!body.includes('path=%2Ftampa%2F')) missing.push('tampa path');
  if (!body.includes('path=%2Ffornex%2F')) missing.push('fornex path');
  if (body.split(`@${FASTLY_ADDRESS}:443`).length - 1 < SERVER_IDS.length) missing.push('FR2 TM line');
  const newConnectionKeys = new Set(
    body.split('\n').filter(Boolean).map((line) => line.split('#', 1)[0])
  );
  const lostLines = change.oldBody
    .split('\n')
    .filter(Boolean)
    .filter((line) => !newConnectionKeys.has(line.split('#', 1)[0]));
  if (lostLines.length) missing.push(`lost ${lostLines.length} existing line(s)`);
  if (missing.length) previewFailures.push({ userId: change.id, missing });
}
if (previewFailures.length) {
  throw new Error(`TM Fastly preview failed: ${JSON.stringify(previewFailures.slice(0, 3))}`);
}

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, users: users.length, serverIds: SERVER_IDS }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `fastly-tm-h3-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(
  backupPath,
  JSON.stringify({ createdAt: timestamp, serviceId: SERVICE_ID, serverDocs, changes: changes.map(({ id, before }) => ({ id, before })) }, null, 2),
  'utf8'
);

const applied = [];
try {
  for (const change of changes) {
    await updateUser(change.id, { ...change.after, updatedAt: nowIso() });
    applied.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after });
  }
} catch (error) {
  for (const change of applied.reverse()) {
    await updateUser(change.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  throw error;
}

const finalFailures = [];
for (const user of (await listUsers(10000)).filter((item) => item.uuid)) {
  const body = await buildUserSubscriptionBody(user);
  const missing = expected.filter((value) => !body.includes(value));
  if (!body.includes('path=%2Ftampa%2F')) missing.push('tampa path');
  if (!body.includes('path=%2Ffornex%2F')) missing.push('fornex path');
  if (body.split(`@${FASTLY_ADDRESS}:443`).length - 1 < SERVER_IDS.length) missing.push('FR2 TM line');
  if (missing.length) finalFailures.push({ userId: user.id, missing });
}
if (finalFailures.length) throw new Error(`TM Fastly post-apply verification failed: ${JSON.stringify(finalFailures.slice(0, 3))}`);

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  updated: applied.length,
  verified: users.length,
  serverIds: SERVER_IDS,
  fastlyAddress: FASTLY_ADDRESS,
  tlsServerName: TLS_SERVER_NAME,
  xhttpHost: XHTTP_HOST,
  backupPath,
  existingLinesRemoved: 0,
}, null, 2));
