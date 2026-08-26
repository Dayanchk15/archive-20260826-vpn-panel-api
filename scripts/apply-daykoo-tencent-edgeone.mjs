#!/usr/bin/env node
/**
 * Daykoo VIP Tencent EdgeOne cutover.
 *
 * Target state:
 * - Daykoo VIP has 4 pinned TE bonus lines: FR1, FR2, Fornex, Tampa.
 * - All lines use the working TM-friendly entrypoint:
 *   TENCENT_EDGE_IP:443 + TLS SNI www.tencentwm.com.
 * - Each origin uses its own EdgeOne hostname so one broken host does not break every line.
 * - Legacy Daykoo Tencent records (old IP/domain variants) are removed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  getUserById,
  listServers,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');

const USER_ID = 'usr_5I2dj1Jiozh0ay-J';
const USER_UUID = '20e742dd-a4d8-4b56-a2c1-e8eff15a800f';
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

function isDaykooTencentServer(server) {
  const id = String(server?.id || '').toLowerCase();
  const blob = JSON.stringify(server || {}).toLowerCase();
  return (
    id.includes('daykoo') &&
    (id.includes('tencent') || id.includes('edgeone') || blob.includes('daykoo-tencent'))
  );
}

function stripIds(values, ids) {
  const remove = new Set([...ids].map(String));
  return dedupe(values).filter((value) => !remove.has(String(value)));
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

function withTargetsFirst(values) {
  return [...TARGET_IDS, ...stripIds(values, TARGET_ID_SET)];
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

function connectionPart(line) {
  return String(line || '').split('#')[0];
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

function isLegacyDaykooTencentLine(line) {
  const text = String(line || '').toLowerCase();
  if (!text.includes('vless://')) return false;
  if (TARGETS.some((target) => text.includes(encodeURIComponent(target.path).toLowerCase()))) {
    return false;
  }
  return (
    text.includes('daykoo-tencent') ||
    text.includes('tencent-edgeone') ||
    text.includes('43.152.43.128') ||
    text.includes('43.174.224.189') ||
    text.includes('43.174.196.76') ||
    text.includes('43.174.224.133') ||
    text.includes('43.157.30.35')
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
    addToNewClients: false,
    allowPinnedRelayOnly: true,
    minInstances: 1,
    maxInstances: 1,
    rejectUdp443: true,
    mobileEnabled: false,
    hiddifyAndroidEnabled: false,
    finalMask: null,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

const users = await listUsers(10000);
const daykoo = await getUserById(USER_ID);
if (!daykoo) throw new Error(`Daykoo VIP user not found: ${USER_ID}`);
if (String(daykoo.uuid || '').toLowerCase() !== USER_UUID) {
  throw new Error(`Unexpected Daykoo UUID: ${daykoo.uuid || '<empty>'}`);
}

const servers = await listServers();
const daykooTencentServers = servers.filter(isDaykooTencentServer);
const obsoleteServers = daykooTencentServers.filter((server) => !TARGET_ID_SET.has(String(server.id)));
const allDaykooTencentIds = new Set([
  ...daykooTencentServers.map((server) => String(server.id)),
  ...TARGET_IDS,
]);
const previousDaykooBody = await buildUserSubscriptionBody(daykoo);
const previousConnections = new Set(
  plainContent(previousDaykooBody)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('vless://'))
    .filter((line) => !isLegacyDaykooTencentLine(line))
    .map(connectionPart)
);

const timestamp = nowIso();
const targetRecords = [];
for (const target of TARGETS) {
  const previous = servers.find((server) => String(server.id) === target.id);
  targetRecords.push(targetServerRecord(target, previous, timestamp));
}

const daykooNext = {
  ...daykoo,
  serverIds: [],
  bonusServerIds: withTargetsFirst(stripIds(daykoo.bonusServerIds || [], allDaykooTencentIds)),
  pinnedServerIds: withTargetsFirst(stripIds(daykoo.pinnedServerIds || [], allDaykooTencentIds)),
  serverAddressIps: {
    ...stripServerAddressIps(daykoo.serverAddressIps, allDaykooTencentIds),
    ...Object.fromEntries(TARGET_IDS.map((id) => [id, EDGE_IP])),
  },
  relayOnly: true,
  updatedAt: timestamp,
};

const userPatches = [];
for (const user of users) {
  const isDaykoo = String(user.id) === USER_ID;
  const nextServerIds = isDaykoo ? [] : stripIds(user.serverIds || [], allDaykooTencentIds);
  const nextBonusServerIds = isDaykoo
    ? daykooNext.bonusServerIds
    : stripIds(user.bonusServerIds || [], allDaykooTencentIds);
  const nextPinnedServerIds = isDaykoo
    ? daykooNext.pinnedServerIds
    : stripIds(user.pinnedServerIds || [], allDaykooTencentIds);
  const nextServerAddressIps = isDaykoo
    ? daykooNext.serverAddressIps
    : stripServerAddressIps(user.serverAddressIps, allDaykooTencentIds);

  const patch = {};
  if (JSON.stringify(nextServerIds) !== JSON.stringify(dedupe(user.serverIds || []))) {
    patch.serverIds = nextServerIds;
  }
  if (JSON.stringify(nextBonusServerIds) !== JSON.stringify(dedupe(user.bonusServerIds || []))) {
    patch.bonusServerIds = nextBonusServerIds;
  }
  if (JSON.stringify(nextPinnedServerIds) !== JSON.stringify(dedupe(user.pinnedServerIds || []))) {
    patch.pinnedServerIds = nextPinnedServerIds;
  }
  if (JSON.stringify(nextServerAddressIps) !== JSON.stringify(user.serverAddressIps || {})) {
    patch.serverAddressIps = nextServerAddressIps;
  }
  if (isDaykoo && user.relayOnly !== true) patch.relayOnly = true;
  if (Object.keys(patch).length) {
    userPatches.push({ user, patch: { ...patch, updatedAt: timestamp } });
  }
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    targetServers: targetRecords.map((server) => ({
      id: server.id,
      addressIp: server.addressIp,
      host: server.host,
      sni: server.sni,
      path: server.path,
      originAddress: server.originAddress,
      originPort: server.originPort,
    })),
    obsoleteServers: obsoleteServers.map((server) => server.id),
    usersToPatch: userPatches.map(({ user, patch }) => ({
      id: user.id,
      name: user.name,
      fields: Object.keys(patch).filter((key) => key !== 'updatedAt'),
    })),
    daykoo: {
      before: {
        serverIds: dedupe(daykoo.serverIds || []),
        bonusServerIds: dedupe(daykoo.bonusServerIds || []),
        pinnedServerIds: dedupe(daykoo.pinnedServerIds || []),
        serverAddressIps: daykoo.serverAddressIps || {},
        relayOnly: daykoo.relayOnly === true,
      },
      after: {
        serverIds: daykooNext.serverIds,
        bonusServerIds: daykooNext.bonusServerIds,
        pinnedServerIds: daykooNext.pinnedServerIds,
        serverAddressIps: daykooNext.serverAddressIps,
        relayOnly: daykooNext.relayOnly,
      },
    },
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `daykoo-tencent-edgeone-lines-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  timestamp,
  daykoo,
  daykooTencentServers,
  obsoleteServers,
  targetRecords,
  users: users.map((user) => ({
    id: user.id,
    name: user.name,
    serverIds: user.serverIds || [],
    bonusServerIds: user.bonusServerIds || [],
    pinnedServerIds: user.pinnedServerIds || [],
    serverAddressIps: user.serverAddressIps || {},
    relayOnly: user.relayOnly === true,
  })),
}, null, 2));

try {
  for (const server of targetRecords) {
    await upsertServer(server.id, server);
  }
  for (const server of obsoleteServers) {
    await deleteServer(server.id, { force: true });
  }
  for (const { user, patch } of userPatches) {
    await updateUser(user.id, patch);
  }

  invalidateSubscriptionBodyCache();

  const freshUsers = await listUsers(10000);
  let refreshedFiles = 0;
  for (const user of freshUsers) {
    await upsertUserSubscriptionFile(user);
    refreshedFiles += 1;
  }

  invalidateSubscriptionBodyCache();
  const finalDaykoo = await getUserById(USER_ID);
  const generatedBody = await buildUserSubscriptionBody(finalDaykoo);
  await upsertUserSubscriptionFile(finalDaykoo);
  const storedFile = await getFileByLinkedUserId(USER_ID);
  const generatedLines = plainContent(generatedBody).split(/\r?\n/).filter(Boolean);
  const storedLines = plainContent(storedFile?.content).split(/\r?\n/).filter(Boolean);

  const generatedTargetLines = generatedLines.filter(isTargetLine);
  const storedTargetLines = storedLines.filter(isTargetLine);
  const generatedLegacyLines = generatedLines.filter(isLegacyDaykooTencentLine);
  const storedLegacyLines = storedLines.filter(isLegacyDaykooTencentLine);
  const targetPathProblems = [];
  for (const target of TARGETS) {
    if (!storedTargetLines.some((line) => isTargetLineForTarget(line, target))) {
      targetPathProblems.push(`${target.id}: missing ${target.host}${target.path}`);
    }
  }
  const finalConnections = new Set(
    storedLines
      .filter((line) => line.startsWith('vless://'))
      .map(connectionPart)
  );
  const lostNonTencent = [...previousConnections].filter((line) => !finalConnections.has(line));

  if (generatedTargetLines.length !== TARGETS.length || storedTargetLines.length !== TARGETS.length) {
    throw new Error(`Target TE line count mismatch generated=${generatedTargetLines.length} stored=${storedTargetLines.length}`);
  }
  if (generatedLegacyLines.length || storedLegacyLines.length) {
    throw new Error(`Legacy Daykoo Tencent lines remain generated=${generatedLegacyLines.length} stored=${storedLegacyLines.length}`);
  }
  if (targetPathProblems.length) {
    throw new Error(`Target TE paths missing: ${targetPathProblems.join('; ')}`);
  }
  if (lostNonTencent.length) {
    throw new Error(`Non-Tencent Daykoo lines lost: ${lostNonTencent.length}`);
  }

  console.log(JSON.stringify({
    ok: true,
    applied: true,
    backupPath,
    targetServers: TARGETS.map((target) => ({
      id: target.id,
      addressIp: EDGE_IP,
      host: target.host,
      sni: FRONT_SNI,
      path: target.path,
      originAddress: target.originAddress,
      originPort: target.originPort,
    })),
    deletedServers: obsoleteServers.map((server) => server.id),
    updatedUsers: userPatches.length,
    refreshedFiles,
    daykoo: {
      id: finalDaykoo.id,
      name: finalDaykoo.name,
      relayOnly: finalDaykoo.relayOnly === true,
      bonusServerIds: finalDaykoo.bonusServerIds || [],
      pinnedServerIds: finalDaykoo.pinnedServerIds || [],
      tencentAddressIps: Object.fromEntries(TARGET_IDS.map((id) => [id, finalDaykoo.serverAddressIps?.[id] || null])),
      generatedTargetLines: generatedTargetLines.length,
      storedTargetLines: storedTargetLines.length,
      legacyTencentLines: 0,
      targetLines: storedTargetLines,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    applied: true,
    backupPath,
    error: error?.message || String(error),
  }, null, 2));
  process.exit(1);
}
