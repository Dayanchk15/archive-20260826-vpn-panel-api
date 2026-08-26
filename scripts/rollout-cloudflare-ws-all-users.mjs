#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const DEFAULT_EDGE_IP = '156.238.181.141';
const TARGET_EDGE_IP = '188.114.97.10';
const FRAGMENTATION = {
  enabled: false,
  length: '2',
  interval: '0-1',
  packets: 'tlshello',
};
const timestamp = nowIso();
const definitions = [
  {
    id: 'cloudflare-fr1-ws-pilot',
    name: 'France FR1',
    country: 'France',
    flag: '🇫🇷',
    host: 'fr1.levospeed.online',
    path: '/',
    sortOrder: -1200,
    originAddress: '185.209.230.14',
  },
  {
    id: 'cloudflare-fr2-ws',
    name: 'France FR2',
    country: 'France',
    flag: '🇫🇷',
    host: 'fr2.levospeed.online',
    path: '/',
    sortOrder: -1199,
    originAddress: '185.209.230.46',
  },
  {
    id: 'cloudflare-fornex-ws',
    name: 'Germany Fornex',
    country: 'Germany',
    flag: '🇩🇪',
    host: 'fornex.levospeed.online',
    path: '/',
    sortOrder: -1198,
    originAddress: '130.17.12.61',
  },
  {
    id: 'cloudflare-tampa-ws',
    name: 'USA Tampa',
    country: 'USA',
    flag: '🇺🇸',
    host: 'tampa.levospeed.online',
    path: '/',
    sortOrder: -1197,
    originAddress: '74.115.172.101',
  },
];
const serverIds = definitions.map((item) => item.id);

function idsFirst(values) {
  const existing = Array.isArray(values) ? values.map(String) : [];
  return [...new Set([...serverIds, ...existing.filter((id) => !serverIds.includes(id))])];
}

function expectedFor(definition, user, publishedAddressById) {
  const edgeIp = String(
    user?.serverAddressIps?.[definition.id]
      || publishedAddressById.get(definition.id)
      || DEFAULT_EDGE_IP
  ).trim();
  return [
    `@${edgeIp}:443`,
    'type=ws',
    `path=${definition.path}`,
    `host=${definition.host}`,
    `sni=${definition.host}`,
    'alpn=http/1.1',
  ];
}

function verifyBody(body, user, publishedAddressById) {
  const failures = [];
  for (const definition of definitions) {
    const line = body.split('\n').find((value) => value.includes(`host=${definition.host}`));
    if (!line) {
      failures.push(`${definition.id}: missing line`);
      continue;
    }
    const missing = expectedFor(definition, user, publishedAddressById)
      .filter((value) => !line.includes(value));
    if (line.includes('fragment=')) missing.push('unexpected fragment parameter');
    if (missing.length) failures.push(`${definition.id}: ${missing.join(', ')}`);
  }
  return failures;
}

const users = (await listUsers(10000)).filter((user) => isUserActive(user));
if (!users.length) throw new Error('No active users found; refusing rollout');
const customUsers = users.filter((user) => user.subscriptionMode === 'custom');
if (customUsers.length) {
  throw new Error(`Custom subscriptions require manual handling: ${customUsers.map((u) => u.id).join(', ')}`);
}

const previousServers = new Map();
for (const definition of definitions) {
  previousServers.set(definition.id, await getServerById(definition.id));
}

const changes = [];
for (const user of users) {
  const before = {
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
    serverAddressIps: user.serverAddressIps && typeof user.serverAddressIps === 'object'
      ? { ...user.serverAddressIps }
      : {},
  };
  changes.push({
    user,
    before,
    after: {
      bonusServerIds: idsFirst(before.bonusServerIds),
      pinnedServerIds: idsFirst(before.pinnedServerIds),
      serverAddressIps: {
        ...before.serverAddressIps,
        ...Object.fromEntries(serverIds.map((id) => [id, TARGET_EDGE_IP])),
      },
    },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    activeUsers: users.length,
    serverIds,
    note: 'Run with --apply after all four origin dataplane probes pass.',
  }, null, 2));
  process.exit(0);
}

const serverDocs = definitions.map((definition) => {
  const existing = previousServers.get(definition.id);
  const edgeIp = TARGET_EDGE_IP;
  const addressIps = [TARGET_EDGE_IP];
  return {
    ...(existing || {}),
    ...definition,
    service: definition.id,
    region: 'cloudflare-global',
    host: definition.host,
    addressIp: edgeIp,
    addressIps,
    forceAddressIp: true,
    port: 443,
    protocol: 'vless',
    network: 'ws',
    security: 'tls',
    sni: definition.host,
    fingerprint: 'chrome',
    alpn: 'http/1.1',
    flow: '',
    enabled: true,
    externalVps: true,
    standalonePilot: false,
    relayPilot: false,
    newUsersOnly: false,
    subscriptionEligible: true,
    subscriptionHidden: false,
    addToNewClients: true,
    allowPinnedRelayOnly: true,
    minInstances: 1,
    maxInstances: 1,
    rejectUdp443: false,
    fragmentation: FRAGMENTATION,
    fragmentationEncoding: 'literal',
    compactWsShareLink: true,
    updatedAt: timestamp,
    createdAt: existing?.createdAt || timestamp,
  };
});
const publishedAddressById = new Map(serverDocs.map((server) => [server.id, server.addressIp]));

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `cloudflare-ws-all-users-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousServers: Object.fromEntries(previousServers),
  changes: changes.map(({ user, before }) => ({ userId: user.id, name: user.name, before })),
}, null, 2), 'utf8');

const appliedUsers = [];
let serverDocsApplied = false;
async function rollback() {
  for (const change of [...appliedUsers].reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before }).catch(() => {});
  }
  if (serverDocsApplied) {
    for (const definition of definitions) {
      const previous = previousServers.get(definition.id);
      if (previous) await upsertServer(definition.id, previous).catch(() => {});
      else await deleteServer(definition.id).catch(() => {});
    }
  }
}

try {
  for (const server of serverDocs) await upsertServer(server.id, server);
  serverDocsApplied = true;
  // oldBody collection above intentionally warms the short-lived body cache.
  // Clear it after publishing the new server docs so preview generation sees
  // the just-added Cloudflare rows instead of the pre-rollout cached bodies.
  invalidateSubscriptionBodyCache();

  const previewFailures = [];
  for (const change of changes) {
    const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
    const missing = verifyBody(body, { ...change.user, ...change.after }, publishedAddressById);
    const allowedChangedHosts = new Set(definitions.flatMap((item) => [
      item.host,
      item.host.replace(/\.online$/, '.click'),
    ]));
    const nextConnectionParts = new Set(
      body.split('\n').filter(Boolean).map((line) => line.split('#')[0])
    );
    const lostLines = change.oldBody.split('\n').filter(Boolean).filter((line) => {
      if (allowedChangedHosts.size && [...allowedChangedHosts].some((host) => line.includes(`host=${host}`))) return false;
      return !nextConnectionParts.has(line.split('#')[0]);
    });
    if (lostLines.length) missing.push(`lost ${lostLines.length} existing line(s)`);
    if (missing.length) {
      const sample = previewFailures.length === 0
        ? body
            .split('\n')
            .filter((line) => definitions.some((item) => line.includes(`host=${item.host}`)))
            .map((line) => line.replace(/^vless:\/\/[^@]+@/, 'vless://UUID@'))
        : undefined;
      previewFailures.push({ userId: change.user.id, missing, sample });
    }
  }
  if (previewFailures.length) {
    throw new Error(`Preview failed for ${previewFailures.length} user(s): ${JSON.stringify(previewFailures.slice(0, 3))}`);
  }

  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    appliedUsers.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after, updatedAt: nowIso() });
  }

  const finalUsers = (await listUsers(10000)).filter((user) => isUserActive(user));
  const finalFailures = [];
  for (const user of finalUsers) {
    const body = await buildUserSubscriptionBody(user);
    const missing = verifyBody(body, user, publishedAddressById);
    if (!serverIds.every((id, index) => String(user.bonusServerIds?.[index]) === id)) {
      missing.push('bonus order');
    }
    if (!serverIds.every((id, index) => String(user.pinnedServerIds?.[index]) === id)) {
      missing.push('pinned order');
    }
    const file = await getFileByLinkedUserId(user.id);
    if (!file?.content || definitions.some((item) => !file.content.includes(`host=${item.host}`))) {
      missing.push('stored subscription file');
    }
    if (missing.length) finalFailures.push({ userId: user.id, missing });
  }
  if (finalUsers.length !== users.length) {
    finalFailures.push({ activeUserCount: `${finalUsers.length} != ${users.length}` });
  }
  if (finalFailures.length) {
    throw new Error(`Final verification failed: ${JSON.stringify(finalFailures.slice(0, 3))}`);
  }

  console.log(JSON.stringify({
    ok: true,
    activeUsersUpdated: appliedUsers.length,
    subscriptionsRefreshed: finalUsers.length,
    serversPublished: serverIds,
    pinnedFirst: true,
    existingLinesRemoved: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rollout rolled back; backup: ${backupPath}`);
}
