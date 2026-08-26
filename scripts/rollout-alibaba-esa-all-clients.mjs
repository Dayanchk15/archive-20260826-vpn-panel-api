#!/usr/bin/env node
/**
 * Roll out Alibaba ESA xHTTP hub lines to active clients.
 *
 * The four public hostnames are intentionally separate. Each hostname should
 * use its own direct Alibaba ESA origin IP so traffic does not hairpin through
 * the FR1 Caddy hub. The xHTTP path selects the local backend on that origin.
 *
 * Safe defaults:
 * - Dry-run unless --apply is passed.
 * - Requires all public hostnames to resolve before applying.
 * - Keeps existing Tencent/Cloudflare/Bunny/Cloud Run lines untouched.
 * - Adds ALI lines as bonus/pinned for selected users and refreshes subscription files.
 * - Keeps ALI records out of automatic new-client assignment during the pilot.
 *
 * Usage:
 *   node scripts/rollout-alibaba-esa-all-clients.mjs
 *   ALIBABA_ESA_EDGE_IP=163.181.0.194 node scripts/rollout-alibaba-esa-all-clients.mjs --apply
 *   node scripts/rollout-alibaba-esa-all-clients.mjs --apply --daykoo-only
 */
import dns from 'node:dns/promises';
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
const DAYKOO_ONLY = process.argv.includes('--daykoo-only');
const SKIP_DNS_CHECK = process.argv.includes('--skip-dns-check');

const EDGE_IP = String(process.env.ALIBABA_ESA_EDGE_IP || '163.181.0.194').trim();
const FRONT_SNI = String(process.env.ALIBABA_ESA_FRONT_SNI || 'www.alibaba.com').trim();
const DOMAIN = String(process.env.ALIBABA_ESA_DOMAIN || 'levospeed.click').trim();
const DIRECT_ORIGIN_PORT = Number(process.env.ALIBABA_ESA_DIRECT_ORIGIN_PORT || 80);

const TARGETS = [
  {
    id: 'alibaba-esa-fr1-daykoo',
    name: 'France Alibaba FR1',
    country: 'France',
    flag: '🇫🇷',
    host: `cdn-a1.${DOMAIN}`,
    path: '/media/v4/fr1/sync',
    originAddress: '185.209.230.14',
    originPort: DIRECT_ORIGIN_PORT,
    backendAddress: '185.209.230.14',
    backendPort: 18097,
    sortOrder: -1760,
  },
  {
    id: 'alibaba-esa-fr2-daykoo',
    name: 'France Alibaba FR2',
    country: 'France',
    flag: '🇫🇷',
    host: `cdn-a2.${DOMAIN}`,
    path: '/media/v4/fr2/sync',
    originAddress: '185.209.230.46',
    originPort: DIRECT_ORIGIN_PORT,
    backendAddress: '185.209.230.46',
    backendPort: 18098,
    sortOrder: -1750,
  },
  {
    id: 'alibaba-esa-fornex-daykoo',
    name: 'Germany Alibaba Fornex',
    country: 'Germany',
    flag: '🇩🇪',
    host: `cdn-a3.${DOMAIN}`,
    path: '/media/v4/fornex/sync',
    originAddress: '130.17.12.61',
    originPort: DIRECT_ORIGIN_PORT,
    backendAddress: '130.17.12.61',
    backendPort: 18098,
    sortOrder: -1740,
  },
  {
    id: 'alibaba-esa-tampa-daykoo',
    name: 'USA Alibaba Tampa',
    country: 'USA',
    flag: '🇺🇸',
    host: `cdn-a4.${DOMAIN}`,
    path: '/media/v4/tampa/sync',
    originAddress: '74.115.172.101',
    originPort: DIRECT_ORIGIN_PORT,
    backendAddress: '74.115.172.101',
    backendPort: 18098,
    sortOrder: -1730,
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
    text.includes(`sni=${encodeURIComponent(FRONT_SNI)}`) &&
    TARGETS.some((target) =>
      text.includes(`host=${target.host}`) &&
      text.includes(`path=${encodeURIComponent(target.path)}`)
    )
  );
}

async function resolve4Safe(host) {
  try {
    return await dns.resolve4(host);
  } catch {
    return [];
  }
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
    region: 'alibaba-esa',
    cloudRunRegion: '',
    sortOrder: target.sortOrder,
    host: target.host,
    addressIp: EDGE_IP,
    addressIps: [EDGE_IP],
    forceAddressIp: true,
    originAddress: target.originAddress,
    originPort: target.originPort,
    backendAddress: target.backendAddress,
    backendPort: target.backendPort,
    port: 443,
    protocol: 'vless',
    network: 'xhttp',
    security: 'tls',
    path: target.path,
    sni: FRONT_SNI,
    alpn: 'h2',
    fingerprint: 'chrome',
    xhttpMode: 'packet-up',
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
    fragmentation: null,
    updatedAt: timestamp,
    createdAt: previous?.createdAt || timestamp,
  };
}

const dnsStatus = await Promise.all(
  TARGETS.map(async (target) => ({
    id: target.id,
    host: target.host,
    ips: await resolve4Safe(target.host),
  }))
);
const missingDns = dnsStatus.filter((row) => row.ips.length === 0);

const [users, servers, panel] = await Promise.all([
  listUsers(10000),
  listServers(),
  getPanelSettings(),
]);
const activeUsers = users.filter(isUserActive);
const targetUsers = DAYKOO_ONLY
  ? activeUsers.filter((user) => String(user.name || '').trim().toLowerCase() === 'daykoo vip')
  : activeUsers;
const inactiveUsers = users.filter((user) => !isUserActive(user));
const serversById = new Map(servers.map((server) => [String(server.id), server]));
const now = nowIso();
const targetRecords = TARGETS.map((target) =>
  targetServerRecord(target, serversById.get(target.id), now)
);

if (DAYKOO_ONLY && targetUsers.length === 0) {
  throw new Error('Daykoo VIP active user was not found');
}

const userPatches = [];
for (const user of targetUsers) {
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
    'network',
    'alpn',
    'xhttpMode',
    'enabled',
    'newUsersOnly',
    'addToNewClients',
    'subscriptionEligible',
    'allowPinnedRelayOnly',
    'rejectUdp443',
    'originAddress',
    'originPort',
  ];
  return keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(record[key]));
});

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    applyBlockedByDns: missingDns.length > 0 && !SKIP_DNS_CHECK,
    dnsStatus,
    panel: {
      subscriptionRelayOnly: panel.subscriptionRelayOnly === true,
      subscriptionWarmOnly: panel.subscriptionWarmOnly !== false,
    },
    mode: DAYKOO_ONLY ? 'daykoo-only' : 'all-active-clients',
    activeUsers: activeUsers.length,
    inactiveUsers: inactiveUsers.length,
    targetUsers: targetUsers.length,
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

if (missingDns.length > 0 && !SKIP_DNS_CHECK) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DNS is not ready for all Alibaba ESA hostnames',
    missingDns,
    hint: 'Create/verify the ESA CNAME/DNS records first, then rerun with --apply.',
  }, null, 2));
  process.exit(1);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `alibaba-esa-${DAYKOO_ONLY ? 'daykoo' : 'all-clients'}-${now.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  timestamp: now,
  mode: DAYKOO_ONLY ? 'daykoo-only' : 'all-active-clients',
  edgeIp: EDGE_IP,
  frontSni: FRONT_SNI,
  dnsStatus,
  targetServersBefore: TARGET_IDS.map((id) => serversById.get(id) || null),
  usersBefore: targetUsers.map((user) => ({
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
for (const user of refreshedUsers.filter((user) =>
  targetUsers.some((targetUser) => String(targetUser.id) === String(user.id))
)) {
  const fresh = await getUserById(user.id);
  const body = plainContent(await buildUserSubscriptionBody(fresh));
  const targetLines = body.split(/\r?\n/).filter(isTargetLine);
  const paths = TARGETS.filter((target) =>
    targetLines.some((line) => line.includes(`path=${encodeURIComponent(target.path)}`))
  ).map((target) => target.id);
  const hosts = TARGETS.filter((target) =>
    targetLines.some((line) => line.includes(`host=${target.host}`))
  ).map((target) => target.host);
  const row = {
    id: fresh.id,
    name: fresh.name,
    targetLines: targetLines.length,
    paths: paths.length,
    hosts: hosts.length,
  };
  verification.push(row);
  if (targetLines.length !== TARGETS.length || paths.length !== TARGETS.length || hosts.length !== TARGETS.length) {
    failed.push(row);
  }
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  applied: true,
  backupPath,
  mode: DAYKOO_ONLY ? 'daykoo-only' : 'all-active-clients',
  dnsStatus,
  targetServers: targetRecords.map((server) => server.id),
  activeUsers: activeUsers.length,
  targetUsers: targetUsers.length,
  updatedUsers: userPatches.length,
  refreshedFiles,
  failed,
  sample: verification.slice(0, 8),
}, null, 2));

process.exit(failed.length === 0 ? 0 : 1);
