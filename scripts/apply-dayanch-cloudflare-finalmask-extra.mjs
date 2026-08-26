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

const APPLY = process.argv.includes('--apply');
const EDGE_IP = '8.6.112.0';
const FINAL_MASK = {
  tcp: [{
    type: 'fragment',
    settings: { delay: '1', length: '3', packets: 'tlshello', maxSplit: '5-10' },
  }],
};
const PROFILES = [
  {
    id: 'cloudflare-finalmask-tampa-dayanch', flag: '🇺🇸', country: 'USA',
    host: 'tampa.levospeed.click', path: '/media/v3/tampa/ws', origin: '74.115.172.101',
  },
  {
    id: 'cloudflare-finalmask-fr1-dayanch', flag: '🇫🇷', country: 'France',
    host: 'fr1.levospeed.click', path: '/media/v3/fr1/ws', origin: '185.209.230.14',
  },
  {
    id: 'cloudflare-finalmask-fornex-dayanch', flag: '🇩🇪', country: 'Germany',
    host: 'fornex.levospeed.click', path: '/media/v3/fornex/ws', origin: '130.17.12.61',
  },
];
const EXISTING_FR2_ID = 'cloudflare-fr2-finalmask-dayanch';
const ORDER = [...PROFILES.map((profile) => profile.id), EXISTING_FR2_ID];

function prepend(ids) {
  const current = Array.isArray(ids) ? ids.map(String) : [];
  const selected = new Set(ORDER);
  return [...ORDER, ...current.filter((id) => !selected.has(id))];
}

function plain(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function links(value) {
  return plain(value).split(/\r?\n/).filter((line) => line.startsWith('vless://'));
}

function connection(line) {
  return String(line || '').split('#')[0];
}

function verify(body) {
  const all = links(body);
  for (const profile of PROFILES) {
    const line = all.find((candidate) => candidate.includes(`host=${profile.host}`));
    if (!line) throw new Error(`${profile.id} missing`);
    const parsed = new URL(line);
    if (
      parsed.hostname !== EDGE_IP || parsed.port !== '443' ||
      parsed.searchParams.get('type') !== 'ws' ||
      parsed.searchParams.get('host') !== profile.host ||
      parsed.searchParams.get('path') !== profile.path ||
      parsed.searchParams.get('sni') !== profile.host ||
      !line.includes('?fm=') || parsed.searchParams.has('fragment')
    ) throw new Error(`${profile.id} link mismatch`);
  }
  const firstFourHosts = all.slice(0, 4).map((line) => new URL(line).searchParams.get('host'));
  const expected = [...PROFILES.map((profile) => profile.host), 'fr2.levospeed.click'];
  if (JSON.stringify(firstFourHosts) !== JSON.stringify(expected)) {
    throw new Error(`Top profile order mismatch: ${firstFourHosts.join(',')}`);
  }
  return all;
}

const [users, dayanch, previousServers] = await Promise.all([
  listUsers(10000),
  getUserById(DAYANCH_VIP_USER_ID),
  Promise.all(PROFILES.map((profile) => getServerById(profile.id))),
]);
if (!dayanch) throw new Error('Dayanch VIP not found');

const before = {
  bonusServerIds: Array.isArray(dayanch.bonusServerIds) ? dayanch.bonusServerIds.map(String) : [],
  pinnedServerIds: Array.isArray(dayanch.pinnedServerIds) ? dayanch.pinnedServerIds.map(String) : [],
};
const after = {
  bonusServerIds: prepend(before.bonusServerIds),
  pinnedServerIds: prepend(before.pinnedServerIds),
};
const bodiesBefore = new Map();
for (const user of users) bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true, dryRun: true, user: { id: dayanch.id, name: dayanch.name },
    add: PROFILES.map(({ id, host, path, origin }) => ({ id, host, path, origin })),
    otherUsersToUpdate: 0,
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `dayanch-cloudflare-finalmask-extra-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, before, previousServers }, null, 2), 'utf8');

let appliedCount = 0;
let userApplied = false;
async function rollback() {
  if (userApplied) {
    const restored = { ...dayanch, ...before, updatedAt: new Date().toISOString() };
    await updateUser(dayanch.id, { ...before, updatedAt: restored.updatedAt }).catch(() => {});
    await upsertUserSubscriptionFile(restored).catch(() => {});
  }
  for (let index = 0; index < appliedCount; index += 1) {
    const previous = previousServers[index];
    const id = PROFILES[index].id;
    if (previous) await upsertServer(id, previous).catch(() => {});
    else await deleteServer(id).catch(() => {});
  }
}

try {
  for (let index = 0; index < PROFILES.length; index += 1) {
    const profile = PROFILES[index];
    const previous = previousServers[index];
    await upsertServer(profile.id, {
      ...(previous || {}),
      id: profile.id,
      service: profile.id,
      name: profile.country,
      country: profile.country,
      flag: profile.flag,
      region: 'cloudflare-finalmask',
      sortOrder: -1700 + index,
      host: profile.host,
      addressIp: EDGE_IP,
      addressIps: [EDGE_IP],
      forceAddressIp: true,
      originAddress: profile.origin,
      port: 443,
      protocol: 'vless',
      network: 'ws',
      security: 'tls',
      path: profile.path,
      sni: profile.host,
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
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    appliedCount += 1;
  }

  const updated = { ...dayanch, ...after, updatedAt: timestamp };
  const preview = await buildUserSubscriptionBody(updated);
  const previewLinks = verify(preview);
  const oldConnections = new Set(links(bodiesBefore.get(String(dayanch.id))).map(connection));
  const newConnections = new Set(previewLinks.map(connection));
  const lost = [...oldConnections].filter((line) => !newConnections.has(line));
  if (lost.length) throw new Error(`Dayanch would lose ${lost.length} existing profile(s)`);

  await updateUser(dayanch.id, { ...after, updatedAt: timestamp });
  userApplied = true;
  await upsertUserSubscriptionFile(updated);
  const stored = await getFileByLinkedUserId(dayanch.id);
  const storedLinks = verify(stored?.content);

  const changedOthers = [];
  for (const user of users) {
    if (String(user.id) === String(dayanch.id)) continue;
    if (await buildUserSubscriptionBody(user) !== bodiesBefore.get(String(user.id))) changedOthers.push(user.id);
  }
  if (changedOthers.length) throw new Error(`Other subscriptions changed: ${changedOthers.length}`);

  console.log(JSON.stringify({
    ok: true,
    user: { id: dayanch.id, name: dayanch.name },
    added: PROFILES.map((profile) => profile.id),
    totalLinks: storedLinks.length,
    topFour: storedLinks.slice(0, 4).map((line) => decodeURIComponent(line.split('#')[1] || '')),
    otherUsersChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
