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
import { applyRelayUserDefaults } from '../lib/relay-subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { nowIso } from '../lib/dates.js';
import { isUserActive } from '../lib/active-users.js';

const APPLY = process.argv.includes('--apply');
const EDGE_IP = '94.20.154.22';
const OLD_BUNNY_IP = '138.199.36.9';
const azDefinitions = [
  {
    id: 'bunny-az-fr2-pilot', name: 'France', country: 'France', flag: '🇫🇷',
    host: 'levospeedfr2.b-cdn.net', path: '/bunny/fr2', originAddress: '185.209.230.46', sortOrder: -1300,
  },
  {
    id: 'bunny-az-fornex-pilot', name: 'Germany', country: 'Germany', flag: '🇩🇪',
    host: 'levospeedfornex.b-cdn.net', path: '/assets/v3/sync', originAddress: '130.17.12.61', sortOrder: -1299,
  },
  {
    id: 'bunny-az-tampa-pilot', name: 'USA', country: 'USA', flag: '🇺🇸',
    host: 'levospeedtampa.b-cdn.net', path: '/bunny/tampa', originAddress: '74.115.172.101', sortOrder: -1298,
  },
];
const azIds = azDefinitions.map((item) => item.id);
const disabledIds = [
  'cloudflare-fr1-ws-pilot',
  'cloudflare-fr2-ws',
  'cloudflare-fornex-ws',
  'cloudflare-tampa-ws',
  'bunny-fr2',
  'bunny-fornex',
];
const removedIdSet = new Set(disabledIds);
const cloudflareHosts = [
  'fr1.levospeed.click',
  'fr2.levospeed.click',
  'fornex.levospeed.click',
  'tampa.levospeed.click',
];

function idsFirst(values) {
  const current = Array.isArray(values) ? values.map(String) : [];
  return [...azIds, ...current.filter((id) => !removedIdSet.has(id) && !azIds.includes(id))];
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function isReplacedConnection(line) {
  if (cloudflareHosts.some((host) => line.includes(`host=${host}`))) return true;
  if (!line.includes(`@${OLD_BUNNY_IP}:443`)) return false;
  return line.includes('host=levospeedfr2.b-cdn.net') || line.includes('host=levospeedfornex.b-cdn.net');
}

function verifyBody(body, { checkFirst = true } = {}) {
  const lines = String(body).split('\n').filter((line) => line.startsWith('vless://'));
  const failures = [];
  for (const [index, definition] of azDefinitions.entries()) {
    const matching = lines.filter((line) => line.includes(`host=${definition.host}`) && line.includes(`@${EDGE_IP}:443`));
    if (matching.length !== 1) failures.push(`${definition.id}: expected 1 AZ line, found ${matching.length}`);
    const line = matching[0] || '';
    for (const expected of [
      'type=ws',
      `path=${encodeURIComponent(definition.path)}`,
      `sni=${definition.host}`,
      'alpn=http%2F1.1',
    ]) {
      if (!line.includes(expected)) failures.push(`${definition.id}: missing ${expected}`);
    }
    if (checkFirst && !(lines[index] || '').includes(`host=${definition.host}`)) {
      failures.push(`${definition.id}: not pinned at position ${index + 1}`);
    }
  }
  for (const host of cloudflareHosts) {
    if (body.includes(`host=${host}`)) failures.push(`old Cloudflare remains: ${host}`);
  }
  for (const host of ['levospeedfr2.b-cdn.net', 'levospeedfornex.b-cdn.net']) {
    if (lines.some((line) => line.includes(`host=${host}`) && line.includes(`@${OLD_BUNNY_IP}:443`))) {
      failures.push(`old Bunny edge remains: ${host}`);
    }
  }
  return failures;
}

const users = (await listUsers(10000)).filter((user) => user.uuid);
if (!users.length) throw new Error('No users with UUID found');
const customUsers = users.filter((user) => user.subscriptionMode === 'custom');
if (customUsers.length) throw new Error(`Custom subscriptions require manual handling: ${customUsers.map((u) => u.id).join(', ')}`);

const allServerIds = [...azIds, ...disabledIds];
const previousServers = new Map();
for (const id of allServerIds) previousServers.set(id, await getServerById(id));
for (const id of disabledIds) {
  if (!previousServers.get(id)) throw new Error(`Server to disable not found: ${id}`);
}

const changes = [];
for (const user of users) {
  const before = {
    serverIds: Array.isArray(user.serverIds) ? user.serverIds.map(String) : [],
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
  };
  changes.push({
    user,
    before,
    after: {
      serverIds: before.serverIds.filter((id) => !removedIdSet.has(id)),
      bonusServerIds: idsFirst(before.bonusServerIds),
      pinnedServerIds: idsFirst(before.pinnedServerIds),
    },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    users: users.length,
    addAndPin: azIds,
    disableAndRemove: disabledIds,
    keepWorkingOldBunnyTampa: true,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const azDocs = azDefinitions.map((definition) => {
  const existing = previousServers.get(definition.id);
  return {
    ...(existing || {}), ...definition,
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
    standalonePilot: false,
    relayPilot: false,
    subscriptionEligible: true,
    subscriptionHidden: false,
    newUsersOnly: false,
    addToNewClients: true,
    allowPinnedRelayOnly: true,
    minInstances: 1,
    maxInstances: 1,
    rejectUdp443: false,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
});

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `bunny-az-all-users-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousServers: Object.fromEntries(previousServers),
  changes: changes.map(({ user, before }) => ({ userId: user.id, name: user.name, before })),
}, null, 2), 'utf8');

let serversApplied = false;
const appliedUsers = [];
async function rollback() {
  if (serversApplied) {
    for (const [id, server] of previousServers) {
      if (server) await upsertServer(id, server).catch(() => {});
    }
  }
  for (const change of [...appliedUsers].reverse()) {
    await updateUser(change.user.id, { ...change.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...change.user, ...change.before, updatedAt: nowIso() }).catch(() => {});
  }
}

try {
  for (const server of azDocs) await upsertServer(server.id, server);
  for (const id of disabledIds) {
    const existing = previousServers.get(id);
    await upsertServer(id, {
      ...existing,
      enabled: false,
      subscriptionEligible: false,
      subscriptionHidden: true,
      addToNewClients: false,
      newUsersOnly: true,
      updatedAt: timestamp,
    });
  }
  serversApplied = true;

  const previewFailures = [];
  for (const change of changes) {
    const body = await buildUserSubscriptionBody({ ...change.user, ...change.after });
    const missing = verifyBody(body);
    const nextConnections = new Set(body.split('\n').filter(Boolean).map(connectionPart));
    const lost = change.oldBody.split('\n').filter(Boolean).filter((line) => {
      if (isReplacedConnection(line)) return false;
      return !nextConnections.has(connectionPart(line));
    });
    if (lost.length) missing.push(`lost ${lost.length} unrelated connection(s)`);
    if (missing.length) previewFailures.push({ userId: change.user.id, missing });
  }
  if (previewFailures.length) {
    throw new Error(`Preview failed for ${previewFailures.length} user(s): ${JSON.stringify(previewFailures.slice(0, 3))}`);
  }

  const futureDefaults = await applyRelayUserDefaults({
    id: 'future-client-probe', uuid: '00000000-0000-4000-8000-000000000001', status: 'active',
  });
  if (!azIds.every((id) => futureDefaults.bonusServerIds?.includes(id))) {
    throw new Error('Future-client auto assignment does not include all Bunny AZ servers');
  }
  if (disabledIds.some((id) => futureDefaults.bonusServerIds?.includes(id))) {
    throw new Error('Future-client auto assignment still includes a disabled server');
  }

  for (const change of changes) {
    await updateUser(change.user.id, { ...change.after, updatedAt: nowIso() });
    appliedUsers.push(change);
  }
  for (const change of changes) {
    await upsertUserSubscriptionFile({ ...change.user, ...change.after, updatedAt: nowIso() });
  }

  const finalUsers = (await listUsers(10000)).filter((user) => user.uuid);
  const finalFailures = [];
  for (const user of finalUsers) {
    const body = await buildUserSubscriptionBody(user);
    const missing = verifyBody(body);
    if (!azIds.every((id, index) => String(user.bonusServerIds?.[index]) === id)) missing.push('bonus order');
    if (!azIds.every((id, index) => String(user.pinnedServerIds?.[index]) === id)) missing.push('pinned order');
    if ([...(user.serverIds || []), ...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])]
      .some((id) => removedIdSet.has(String(id)))) missing.push('removed server ID still assigned');
    const stored = await getFileByLinkedUserId(user.id);
    if (!stored?.content) missing.push('stored subscription missing');
    if (isUserActive(user) && verifyBody(stored?.content, { checkFirst: false }).length) {
      missing.push('stored active subscription');
    }
    if (missing.length) finalFailures.push({ userId: user.id, missing });
  }
  if (finalFailures.length) {
    throw new Error(`Final verification failed: ${JSON.stringify(finalFailures.slice(0, 3))}`);
  }

  console.log(JSON.stringify({
    ok: true,
    usersUpdated: appliedUsers.length,
    subscriptionsRefreshed: finalUsers.length,
    addedAndPinnedFirst: azIds,
    disabledAndRemoved: disabledIds,
    keptWorkingBunnyTampa: true,
    futureClientsAutoAssigned: true,
    unrelatedConnectionsRemoved: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
