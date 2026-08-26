#!/usr/bin/env node
/**
 * Update existing Tencent EdgeOne connect IPs without changing assignment scope.
 *
 * - Updates the four known Tencent EdgeOne server records.
 * - Updates user.serverAddressIps only for users that already reference those IDs.
 * - Does not add Tencent lines to users that do not already have them.
 * - Refreshes subscription files and verifies affected subscriptions use the new IP.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const NEW_IP = String(process.env.TENCENT_EDGE_IP || process.argv.find((arg) => /^\d+\.\d+\.\d+\.\d+$/.test(arg)) || '43.159.98.2').trim();
const OLD_IPS = new Set(['43.159.99.106', '43.174.224.189', '43.174.196.76', '43.174.224.133']);
const FRONT_SNI = 'www.tencentwm.com';
const TARGET_HOST_BY_ID = new Map([
  ['tencent-edgeone-fr1-daykoo', 'daykoo-tencent-fr1.levospeed.click'],
  ['tencent-edgeone-fr2-daykoo', 'daykoo-tencent-fr2.levospeed.click'],
  ['tencent-edgeone-fornex-daykoo', 'daykoo-tencent-fornex.levospeed.click'],
  ['tencent-edgeone-tampa-daykoo', 'daykoo-tencent-tampa.levospeed.click'],
]);
const TARGET_PATH_BY_ID = new Map([
  ['tencent-edgeone-fr1-daykoo', '/eo/v1/4bfa6f260da5'],
  ['tencent-edgeone-fr2-daykoo', '/eo/v1/a91c2e7b4d08'],
  ['tencent-edgeone-fornex-daykoo', '/eo/v1/c3f8a1d92e44'],
  ['tencent-edgeone-tampa-daykoo', '/eo/v1/e7b4d01a6c29'],
]);
const TARGET_IDS = [
  ...TARGET_HOST_BY_ID.keys(),
  'tencent-edgeone-fr1-wifi-daykoo',
];
const TARGET_SET = new Set(TARGET_IDS);
const TARGET_HOSTS = new Set(TARGET_HOST_BY_ID.values());

function hasAnyTarget(values) {
  return Array.isArray(values) && values.some((id) => TARGET_SET.has(String(id)));
}

function userReferencesTencent(user) {
  if (hasAnyTarget(user.serverIds) || hasAnyTarget(user.bonusServerIds) || hasAnyTarget(user.pinnedServerIds)) return true;
  const ips = user.serverAddressIps && typeof user.serverAddressIps === 'object' ? user.serverAddressIps : {};
  return Object.keys(ips).some((id) => TARGET_SET.has(String(id)));
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

function tencentLines(body) {
  return plainContent(body)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('vless://'))
    .filter((line) => (
      line.includes(`sni=${FRONT_SNI}`) &&
      [...TARGET_HOSTS].some((host) => line.includes(`host=${host}`))
    ));
}

function wrongHostTencentLine(line) {
  const text = String(line || '');
  for (const [id, targetPath] of TARGET_PATH_BY_ID) {
    const encodedPath = encodeURIComponent(targetPath);
    if (text.includes(`path=${encodedPath}`)) {
      const expectedHost = TARGET_HOST_BY_ID.get(id);
      return expectedHost && !text.includes(`host=${expectedHost}`);
    }
  }
  return false;
}

if (!/^\d+\.\d+\.\d+\.\d+$/.test(NEW_IP)) {
  throw new Error(`Invalid TENCENT_EDGE_IP: ${NEW_IP}`);
}

const now = nowIso();
const serverBefore = [];
const serverPatches = [];
for (const id of TARGET_IDS) {
  const server = await getServerById(id);
  if (!server) continue;
  serverBefore.push(server);
  const previousIps = Array.isArray(server.addressIps) ? server.addressIps.map(String) : [];
  const expectedHost = TARGET_HOST_BY_ID.get(id);
  const next = {
    ...server,
    ...(expectedHost ? {
      host: expectedHost,
      originMode: 'direct-per-origin',
      originProtocol: 'http',
      hubHost: null,
      hubNote: null,
    } : {}),
    addressIp: NEW_IP,
    addressIps: [NEW_IP, ...previousIps.filter((ip) => ip !== NEW_IP && !OLD_IPS.has(ip))],
    forceAddressIp: true,
    updatedAt: now,
  };
  if (
    server.addressIp !== NEW_IP ||
    JSON.stringify(server.addressIps || []) !== JSON.stringify(next.addressIps) ||
    (expectedHost && (
      server.host !== expectedHost ||
      server.originMode !== 'direct-per-origin' ||
      server.originProtocol !== 'http' ||
      server.hubHost !== null ||
      server.hubNote !== null
    ))
  ) {
    serverPatches.push(next);
  }
}

const users = await listUsers(10000);
const affectedUsers = users.filter(userReferencesTencent);
const userPatches = [];
for (const user of affectedUsers) {
  const beforeIps = user.serverAddressIps && typeof user.serverAddressIps === 'object' ? user.serverAddressIps : {};
  const nextIps = { ...beforeIps };
  let changed = false;
  for (const id of TARGET_IDS) {
    if (
      TARGET_SET.has(id) &&
      (
        hasAnyTarget(user.serverIds) ||
        hasAnyTarget(user.bonusServerIds) ||
        hasAnyTarget(user.pinnedServerIds) ||
        Object.prototype.hasOwnProperty.call(beforeIps, id)
      )
    ) {
      if (nextIps[id] !== NEW_IP) {
        nextIps[id] = NEW_IP;
        changed = true;
      }
    }
  }
  if (changed) userPatches.push({ user, patch: { serverAddressIps: nextIps, updatedAt: now } });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    newIp: NEW_IP,
    serverPatches: serverPatches.map((server) => ({
      id: server.id,
      addressIp: server.addressIp,
      addressIps: server.addressIps,
      host: server.host,
      originProtocol: server.originProtocol,
    })),
    affectedUsers: affectedUsers.length,
    usersToPatch: userPatches.map(({ user }) => ({ id: user.id, name: user.name })),
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `tencent-edgeone-ip-${NEW_IP.replace(/\./g, '-')}-${now.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  timestamp: now,
  newIp: NEW_IP,
  targetIds: TARGET_IDS,
  serverBefore,
  usersBefore: affectedUsers.map((user) => ({
    id: user.id,
    name: user.name,
    serverAddressIps: user.serverAddressIps || {},
    serverIds: user.serverIds || [],
    bonusServerIds: user.bonusServerIds || [],
    pinnedServerIds: user.pinnedServerIds || [],
  })),
}, null, 2));

for (const server of serverPatches) await upsertServer(server.id, server);
for (const { user, patch } of userPatches) await updateUser(user.id, patch);

invalidateSubscriptionBodyCache();
const freshUsers = await listUsers(10000);
let refreshedFiles = 0;
for (const user of freshUsers) {
  await upsertUserSubscriptionFile(user);
  refreshedFiles += 1;
}
invalidateSubscriptionBodyCache();

const failed = [];
for (const user of freshUsers.filter(userReferencesTencent)) {
  const lines = tencentLines(await buildUserSubscriptionBody(user));
  const wrong = lines.filter((line) => !line.includes(`@${NEW_IP}:443`));
  const wrongHost = lines.filter(wrongHostTencentLine);
  if (lines.length && (wrong.length || wrongHost.length)) {
    failed.push({ id: user.id, name: user.name, lines: lines.length, wrong: wrong.length, wrongHost: wrongHost.length });
  }
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  applied: true,
  newIp: NEW_IP,
  backupPath,
  serverPatches: serverPatches.map((server) => server.id),
  affectedUsers: affectedUsers.length,
  updatedUsers: userPatches.length,
  refreshedFiles,
  failed,
}, null, 2));
if (failed.length) process.exit(1);
