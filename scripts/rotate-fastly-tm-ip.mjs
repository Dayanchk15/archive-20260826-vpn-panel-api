#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const TARGET_IP = String(process.env.FASTLY_TARGET_IP || '199.232.247.140').trim();
const SERVER_IDS = [
  'tm-tampa-fastly-h3',
  'tm-fornex-fastly-h3',
  'tm-fr2-fastly-h3',
];

if (!/^199\.232\.247\.(?:140|141|142|143)$/.test(TARGET_IP)) {
  throw new Error(`Unexpected Fastly target IP: ${TARGET_IP}`);
}

const [servers, users] = await Promise.all([
  Promise.all(SERVER_IDS.map((id) => getServerById(id))),
  listUsers(10000),
]);
if (servers.some((server) => !server)) throw new Error('Missing production Fastly H3 server');

const updatedServers = servers.map((server) => ({
  ...server,
  addressIp: TARGET_IP,
  addressIps: [TARGET_IP],
  fastlyAddress: TARGET_IP,
  forceAddressIp: true,
  updatedAt: nowIso(),
}));

// Build against the temporary server records, then restore them for dry-run.
for (const server of updatedServers) await upsertServer(server.id, server);

const failures = [];
for (const user of users.filter((item) => item.uuid)) {
  const body = await buildUserSubscriptionBody(user);
  const assigned = SERVER_IDS.some((id) =>
    [...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])].includes(id)
  );
  if (!assigned) continue;
  const count = body.split(`@${TARGET_IP}:443`).length - 1;
  if (count < 3 || !body.includes('alpn=h3')) failures.push({ userId: user.id, count });
}

if (!APPLY || failures.length) {
  for (const server of servers) await upsertServer(server.id, server);
  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: !APPLY,
    targetIp: TARGET_IP,
    users: users.filter((item) => item.uuid).length,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
  process.exit();
}

const timestamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `fastly-ip-rotation-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, targetIp: TARGET_IP, servers }, null, 2));

let refreshed = 0;
try {
  for (const user of users.filter((item) => item.uuid)) {
    await upsertUserSubscriptionFile(user);
    refreshed += 1;
  }
} catch (error) {
  for (const server of servers) await upsertServer(server.id, server).catch(() => {});
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  targetIp: TARGET_IP,
  updatedServers: SERVER_IDS,
  refreshedSubscriptions: refreshed,
  backupPath,
}, null, 2));
