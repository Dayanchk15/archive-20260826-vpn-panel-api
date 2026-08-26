#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const EDGE_IP = '199.232.247.142';
const SERVER_IDS = [
  'tm-tampa-fastly-h3',
  'tm-fornex-fastly-h3',
  'tm-fr2-fastly-h3',
];

const before = [];
for (const id of SERVER_IDS) {
  const server = await getServerById(id);
  if (!server) throw new Error(`Missing server ${id}`);
  before.push(server);
}

const assignedUsers = (await listUsers(10000)).filter((user) =>
  user?.uuid && SERVER_IDS.some((id) =>
    user.bonusServerIds?.includes(id) || user.pinnedServerIds?.includes(id)
  )
);

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    edgeIp: EDGE_IP,
    servers: SERVER_IDS,
    assignedUsers: assignedUsers.length,
    userAssignmentsChanged: 0,
  }, null, 2));
  process.exit();
}

const timestamp = nowIso();
const backupDir = '/data/files/backups';
const backupPath = `${backupDir}/fastly-edge-ip-${timestamp.replace(/[:.]/g, '-')}.json`;
await mkdir(backupDir, { recursive: true });
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, servers: before }, null, 2));

try {
  for (const server of before) {
    await upsertServer(server.id, {
      ...server,
      addressIp: EDGE_IP,
      addressIps: [EDGE_IP],
      fastlyAddress: EDGE_IP,
      forceAddressIp: true,
      addToNewClients: false,
      updatedAt: timestamp,
    });
  }

  const failures = [];
  for (const user of assignedUsers) {
    const body = await buildUserSubscriptionBody(user);
    const count = body.split(`@${EDGE_IP}:443`).length - 1;
    if (count < 3 || body.includes('@199.232.247.140:443')) {
      failures.push({ userId: user.id, count });
    }
  }
  if (failures.length) throw new Error(`Subscription validation failed: ${JSON.stringify(failures.slice(0, 5))}`);

  for (const user of assignedUsers) await upsertUserSubscriptionFile(user);
} catch (error) {
  for (const server of before) await upsertServer(server.id, server);
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  applied: true,
  edgeIp: EDGE_IP,
  servers: SERVER_IDS,
  refreshedUsers: assignedUsers.length,
  userAssignmentsChanged: 0,
  addToNewClients: false,
  backupPath,
}, null, 2));
