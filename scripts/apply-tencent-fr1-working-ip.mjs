#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';

import {
  getServerById,
  getUserById,
  listUsers,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { invalidateSubscriptionBodyCache } from '/app/lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const TARGET_ID = 'tencent-edgeone-fr1-daykoo';
const TARGET_IP = String(process.env.TENCENT_FR1_IP || '43.159.98.111').trim();
const EXPECTED = {
  host: 'daykoo-tencent-fr1.levospeed.click',
  path: '/',
  sni: 'www.tencentwm.com',
  network: 'ws',
  security: 'tls',
  alpn: 'http/1.1',
  originAddress: '185.209.230.14',
  originPort: 18109,
};

if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(TARGET_IP)) throw new Error('Invalid TENCENT_FR1_IP');

const server = await getServerById(TARGET_ID);
if (!server) throw new Error(`${TARGET_ID} not found`);

const users = await listUsers(10000);
const referencesTarget = (user) => {
  const fields = ['serverIds', 'bonusServerIds', 'pinnedServerIds'];
  return fields.some((field) => Array.isArray(user[field]) && user[field].map(String).includes(TARGET_ID)) ||
    Object.prototype.hasOwnProperty.call(user.serverAddressIps || {}, TARGET_ID);
};
const affectedUsers = users.filter(referencesTarget);

const nextServer = {
  ...server,
  ...EXPECTED,
  addressIp: TARGET_IP,
  addressIps: [TARGET_IP],
  forceAddressIp: true,
  updatedAt: nowIso(),
};

const userPatches = affectedUsers.map((user) => ({
  user,
  patch: {
    serverAddressIps: { ...(user.serverAddressIps || {}), [TARGET_ID]: TARGET_IP },
    updatedAt: nowIso(),
  },
}));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    serverBefore: {
      id: server.id,
      addressIp: server.addressIp,
      path: server.path,
      originPort: server.originPort,
    },
    serverAfter: {
      id: nextServer.id,
      addressIp: nextServer.addressIp,
      path: nextServer.path,
      originPort: nextServer.originPort,
    },
    affectedUsers: affectedUsers.map(({ id, name }) => ({ id, name })),
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const backupRoot = process.env.LOCAL_STORAGE_DIR || '/data/files';
const backupDirectory = `${backupRoot}/backups`;
await mkdir(backupDirectory, { recursive: true });
const backupPath = `${backupDirectory}/tencent-fr1-working-ip-${timestamp.replace(/[:.]/g, '-')}.json`;
await writeFile(backupPath, JSON.stringify({
  timestamp,
  targetId: TARGET_ID,
  targetIp: TARGET_IP,
  serverBefore: server,
  usersBefore: affectedUsers.map((user) => ({
    id: user.id,
    name: user.name,
    serverAddressIps: user.serverAddressIps || {},
  })),
}, null, 2));

await upsertServer(TARGET_ID, nextServer);
for (const { user, patch } of userPatches) await updateUser(user.id, patch);

invalidateSubscriptionBodyCache();
const refreshed = [];
const failures = [];
for (const oldUser of affectedUsers) {
  try {
    const user = await getUserById(oldUser.id);
    await upsertUserSubscriptionFile(user);
    refreshed.push({ id: user.id, name: user.name });
  } catch (error) {
    failures.push({ id: oldUser.id, name: oldUser.name, error: error?.message || String(error) });
  }
}
invalidateSubscriptionBodyCache();

const verification = [];
for (const oldUser of affectedUsers) {
  const user = await getUserById(oldUser.id);
  const body = await buildUserSubscriptionBody(user);
  const plain = String(body).includes('vless://') ? String(body) : Buffer.from(String(body), 'base64').toString('utf8');
  const lines = plain.split(/\r?\n/).filter((line) => line.startsWith('vless://'));
  const line = lines.find((value) => value.includes(`host=${EXPECTED.host}`));
  verification.push({
    id: user.id,
    name: user.name,
    found: Boolean(line),
    correctIp: Boolean(line?.includes(`@${TARGET_IP}:443`)),
    correctPath: Boolean(line && new URL(line).searchParams.get('path') === '/'),
    correctSni: Boolean(line && new URL(line).searchParams.get('sni') === EXPECTED.sni),
  });
}

const verificationFailed = verification.filter((item) =>
  !item.found || !item.correctIp || !item.correctPath || !item.correctSni
);
console.log(JSON.stringify({
  ok: failures.length === 0 && verificationFailed.length === 0,
  applied: true,
  targetId: TARGET_ID,
  targetIp: TARGET_IP,
  backupPath,
  affectedUsers: affectedUsers.length,
  refreshed: refreshed.length,
  failures,
  verification,
  verificationFailed,
}, null, 2));
if (failures.length || verificationFailed.length) process.exitCode = 1;
