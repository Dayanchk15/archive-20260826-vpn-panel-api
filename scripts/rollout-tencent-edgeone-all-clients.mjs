#!/usr/bin/env node
/**
 * Roll out the Tencent EdgeOne WS direct-origin lines to every active client.
 *
 * Safe defaults:
 * - Keeps the existing main subscription pool untouched.
 * - Publishes TE nodes as bonus/pinned lines for every active user.
 * - Keeps TE records addToNewClients=true so new relay-only users receive them.
 * - Refreshes stored subscription files and verifies every active auto user sees 4 TE lines.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getServerById,
  getUserById,
  listServers,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');

// Confirmed through a TM mobile-network scan on 2026-08-12.
const EDGE_IP = String(process.env.TENCENT_EDGE_IP || '43.159.107.31').trim();
const FRONT_SNI = 'www.tencentwm.com';

const TARGETS = [
  {
    id: 'tencent-edgeone-fr1-daykoo',
    name: 'France Tencent FR1',
    country: 'France',
    host: 'daykoo-tencent-fr1.levospeed.click',
    flag: '🇫🇷',
    path: '/',
    originAddress: '185.209.230.14',
    originPort: 18109,
    sortOrder: -1800,
  },
  {
    id: 'tencent-edgeone-fr2-daykoo',
    name: 'France Tencent FR2',
    country: 'France',
    host: 'daykoo-tencent-fr2.levospeed.click',
    flag: '🇫🇷',
    path: '/',
    originAddress: '185.209.230.46',
    originPort: 18109,
    sortOrder: -1790,
  },
  {
    id: 'tencent-edgeone-fornex-daykoo',
    name: 'Germany Tencent Fornex',
    country: 'Germany',
    host: 'daykoo-tencent-fornex.levospeed.click',
    flag: '🇩🇪',
    path: '/',
    originAddress: '130.17.12.61',
    originPort: 18109,
    sortOrder: -1780,
  },
  {
    id: 'tencent-edgeone-tampa-daykoo',
    name: 'USA Tencent Tampa',
    country: 'USA',
    host: 'daykoo-tencent-tampa.levospeed.click',
    flag: '🇺🇸',
    path: '/',
    originAddress: '74.115.172.101',
    originPort: 18109,
    sortOrder: -1770,
  },
];

const TARGET_IDS = TARGETS.map((target) => target.id);
const TARGET_ID_SET = new Set(TARGET_IDS);

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stripIds(values, ids) {
  const remove = new Set([...ids].map(String));
  return dedupe(values).filter((value) => !remove.has(String(value)));
}

function withTargetsFirst(values) {
  return [...TARGET_IDS, ...stripIds(values, TARGET_ID_SET)];
}

function stripServerAddressIps(value, ids) {
  const remove = new Set([...ids].map(String));
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [key, ip] of Object.entries(source)) {
    if (!remove.has(String(key))) out[key] = ip;
  }
  return out;
}

function stableObject(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source).sort(([left], [right]) => String(left).localeCompare(String(right)))
  );
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

function isTargetLine(line) {
  const text = String(line || '');
  return (
    text.includes(`@${EDGE_IP}:443`) &&
    text.includes(`sni=${FRONT_SNI}`) &&
    TARGETS.some((target) => text.includes(`host=${target.host}`))
  );
}

function isTargetLineForTarget(line, target) {
  const text = String(line || '');
  return (
    isTargetLine(text) &&
    text.includes(`host=${target.host}`) &&
    text.includes(`path=${encodeURIComponent(target.path)}`)
  );
}

function targetServerRecord(target, previous, timestamp) {
  return {
    ...(previous || {}),
    id: target.id,
    service: target.id,
    cloudRunService: target.id,
    name: target.name,
    country: target.country,
    flag: target.flag,
    region: 'tencent-edgeone',
    cloudRunRegion: '',
    sortOrder: target.sortOrder,
    host: target.host,
    addressIp: EDGE_IP,
    addressIps: [EDGE_IP],
    forceAddressIp: true,
    originMode: 'direct-per-origin',
    originAddress: target.originAddress,
    originPort: target.originPort,
    originProtocol: 'http',
    hubHost: null,
    hubNote: null,
    port: 443,
    protocol: 'vless',
    network: 'ws',
    security: 'tls',
    path: target.path,
    sni: FRONT_SNI,
    alpn: 'http/1.1',
    fingerprint: 'chrome',
    flow: '',
    enabled: true,
    externalVps: true,
    standalonePilot: true,
    relayPilot: false,
    subscriptionEligible: true,
    subscriptionHidden: false,
    newUsersOnly: true,
    addToNewClients: true,
    allowPinnedRelayOnly: true,
    minInstances: 1,
    maxInstances: 1,
    rejectUdp443: true,
    mobileEnabled: false,
    hiddifyAndroidEnabled: false,
    finalMask: null,
    updatedAt: timestamp,
    createdAt: previous?.createdAt || timestamp,
  };
}

const [users, servers, panel] = await Promise.all([
  listUsers(10000),
  listServers(),
  getPanelSettings(),
]);
const activeUsers = users.filter(isUserActive);
const inactiveUsers = users.filter((user) => !isUserActive(user));
const serversById = new Map(servers.map((server) => [String(server.id), server]));
const now = nowIso();
const targetRecords = TARGETS.map((target) =>
  targetServerRecord(target, serversById.get(target.id), now)
);

const userPatches = [];
for (const user of activeUsers) {
  const beforeBonus = dedupe(user.bonusServerIds || []);
  const beforePinned = dedupe(user.pinnedServerIds || []);
  const beforeIps = user.serverAddressIps || {};
  const nextBonus = withTargetsFirst(beforeBonus);
  const nextPinned = withTargetsFirst(beforePinned);
  const nextIps = {
    ...stripServerAddressIps(beforeIps, TARGET_ID_SET),
    ...Object.fromEntries(TARGET_IDS.map((id) => [id, EDGE_IP])),
  };

  const patch = {};
  if (JSON.stringify(nextBonus) !== JSON.stringify(beforeBonus)) patch.bonusServerIds = nextBonus;
  if (JSON.stringify(nextPinned) !== JSON.stringify(beforePinned)) patch.pinnedServerIds = nextPinned;
  if (JSON.stringify(stableObject(nextIps)) !== JSON.stringify(stableObject(beforeIps))) {
    patch.serverAddressIps = nextIps;
  }
  if (Object.keys(patch).length) {
    userPatches.push({ user, patch: { ...patch, updatedAt: now } });
  }
}

const serverPatches = targetRecords.filter((record) => {
  const previous = serversById.get(record.id) || {};
  const keys = [
    'host',
    'addressIp',
    'sni',
    'path',
    'enabled',
    'newUsersOnly',
    'addToNewClients',
    'subscriptionEligible',
    'allowPinnedRelayOnly',
    'rejectUdp443',
    'originAddress',
    'originPort',
    'originProtocol',
    'originMode',
    'hubHost',
    'hubNote',
  ];
  return keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(record[key]));
});

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    panel: {
      subscriptionRelayOnly: panel.subscriptionRelayOnly === true,
      subscriptionWarmOnly: panel.subscriptionWarmOnly !== false,
    },
    activeUsers: activeUsers.length,
    inactiveUsers: inactiveUsers.length,
    serverPatches: serverPatches.map((server) => server.id),
    usersToPatch: userPatches.map(({ user, patch }) => ({
      id: user.id,
      name: user.name,
      fields: Object.keys(patch).filter((key) => key !== 'updatedAt'),
    })),
    targetServers: targetRecords.map((server) => ({
      id: server.id,
      addressIp: server.addressIp,
      host: server.host,
      sni: server.sni,
      path: server.path,
      addToNewClients: server.addToNewClients,
      newUsersOnly: server.newUsersOnly,
    })),
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `tencent-edgeone-all-clients-${now.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  timestamp: now,
  targetServersBefore: TARGET_IDS.map((id) => serversById.get(id) || null),
  activeUsers: activeUsers.map((user) => ({
    id: user.id,
    name: user.name,
    bonusServerIds: user.bonusServerIds || [],
    pinnedServerIds: user.pinnedServerIds || [],
    serverAddressIps: user.serverAddressIps || {},
  })),
}, null, 2));

for (const record of targetRecords) {
  await upsertServer(record.id, record);
}

for (const { user, patch } of userPatches) {
  await updateUser(user.id, patch);
}

invalidateSubscriptionBodyCache();

let refreshedFiles = 0;
const refreshedUsers = await listUsers(10000);
for (const user of refreshedUsers) {
  await upsertUserSubscriptionFile(user);
  refreshedFiles += 1;
}

invalidateSubscriptionBodyCache();

const verification = [];
const failed = [];
for (const user of refreshedUsers.filter(isUserActive)) {
  const fresh = await getUserById(user.id);
  const body = plainContent(await buildUserSubscriptionBody(fresh));
  const targetLines = body.split(/\r?\n/).filter(isTargetLine);
  const matchedTargets = TARGETS.filter((target) =>
    targetLines.some((line) => isTargetLineForTarget(line, target))
  ).map((target) => target.id);
  const row = {
    id: fresh.id,
    name: fresh.name,
    targetLines: targetLines.length,
    matchedTargets: matchedTargets.length,
  };
  verification.push(row);
  if (targetLines.length !== TARGETS.length || matchedTargets.length !== TARGETS.length) {
    failed.push(row);
  }
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  applied: true,
  backupPath,
  targetServers: targetRecords.map((server) => server.id),
  activeUsers: activeUsers.length,
  updatedUsers: userPatches.length,
  refreshedFiles,
  failed,
  sample: verification.slice(0, 8),
}, null, 2));

process.exit(failed.length === 0 ? 0 : 1);
