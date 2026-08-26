#!/usr/bin/env node
import { getUserById, listServers, listUsers, updateUser, upsertServer } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';
import { nowIso } from '/app/lib/dates.js';

const SERVER_ID = 'worker-tampa-pilot';
const WORKER_HOST = 'levospeed-tm-pilot.kakamyradovdayanch.workers.dev';
const now = nowIso();

const users = await listUsers(5000);
const unexpected = users.filter(
  (user) =>
    String(user.id) !== String(DAYANCH_VIP_USER_ID) &&
    [...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])].map(String).includes(SERVER_ID)
);
if (unexpected.length) {
  throw new Error(`Pilot is already assigned to other users: ${unexpected.map((user) => user.id).join(', ')}`);
}

const existing = (await listServers()).find((server) => String(server.id) === SERVER_ID);
await upsertServer(SERVER_ID, {
  id: SERVER_ID,
  name: 'Tampa Worker pilot',
  country: 'USA TEST',
  flag: '🇺🇸',
  host: WORKER_HOST,
  addressIp: WORKER_HOST,
  forceAddressIp: true,
  port: 443,
  protocol: 'vless',
  security: 'tls',
  network: 'ws',
  path: '/tampa',
  sni: WORKER_HOST,
  alpn: 'http/1.1',
  fingerprint: 'chrome',
  service: SERVER_ID,
  enabled: true,
  minInstances: 1,
  maxInstances: 1,
  externalVps: true,
  subscriptionEligible: true,
  addToNewClients: false,
  newUsersOnly: true,
  subscriptionHidden: false,
  allowPinnedRelayOnly: true,
  rejectUdp443: true,
  sortOrder: existing?.sortOrder ?? 1,
  createdAt: existing?.createdAt || now,
  updatedAt: now,
});

const user = await getUserById(DAYANCH_VIP_USER_ID);
if (!user) throw new Error('Dayanch VIP user not found');

const bonusServerIds = [SERVER_ID, ...(user.bonusServerIds || []).map(String).filter((id) => id !== SERVER_ID)];
const pinnedServerIds = [SERVER_ID, ...(user.pinnedServerIds || []).map(String).filter((id) => id !== SERVER_ID)];
const updatedUser = { ...user, bonusServerIds, pinnedServerIds, updatedAt: nowIso() };

await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt: updatedUser.updatedAt });
await upsertUserSubscriptionFile(updatedUser);

const body = await buildUserSubscriptionBody(updatedUser);
if (!body.includes(`@${WORKER_HOST}:443`) || !body.includes('path=%2Ftampa')) {
  throw new Error('Dayanch subscription was refreshed but Worker pilot link is missing');
}

console.log(JSON.stringify({
  ok: true,
  serverId: SERVER_ID,
  user: { id: user.id, name: user.name },
  assignedUsers: 1,
  otherUsersUpdated: 0,
  pinnedFirst: pinnedServerIds[0] === SERVER_ID,
  subscriptionContainsWorker: true,
}, null, 2));
