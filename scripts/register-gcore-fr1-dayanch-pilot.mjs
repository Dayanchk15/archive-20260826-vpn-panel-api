#!/usr/bin/env node
import {
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
import { nowIso } from '/app/lib/dates.js';

const SERVER_ID = 'gcore-fr1-pilot';
const HOST = 'gcore-fr1.levospeed.click';
const EDGE_IP = String(process.env.GCORE_EDGE_IP || '81.28.12.12').trim();
const WS_PATH = '/media/v3/fr1/ws';

function plainSubscriptionContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const users = await listUsers(5000);
const dayanch = await getUserById(DAYANCH_VIP_USER_ID);
if (!dayanch) throw new Error('Dayanch VIP user not found');

const bodiesBefore = new Map();
for (const user of users) {
  bodiesBefore.set(String(user.id), await buildUserSubscriptionBody(user));
}

const existingServer = await getServerById(SERVER_ID);
const originalBonus = Array.isArray(dayanch.bonusServerIds)
  ? dayanch.bonusServerIds.map(String)
  : [];
const originalPinned = Array.isArray(dayanch.pinnedServerIds)
  ? dayanch.pinnedServerIds.map(String)
  : [];
const timestamp = nowIso();
const server = {
  ...existingServer,
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'Франция',
  country: 'France',
  flag: '🇫🇷',
  sortOrder: -1000,
  host: HOST,
  // Connect to the Gcore IPv4 edge directly. This avoids broken/blocked DNS
  // and IPv6 selection on TM networks while Host/SNI still select our resource.
  addressIp: EDGE_IP,
  forceAddressIp: true,
  port: 443,
  protocol: 'vless',
  network: 'ws',
  security: 'tls',
  path: WS_PATH,
  sni: HOST,
  alpn: 'http/1.1',
  fingerprint: 'chrome',
  enabled: true,
  externalVps: true,
  standalonePilot: true,
  subscriptionEligible: true,
  subscriptionHidden: false,
  newUsersOnly: true,
  addToNewClients: false,
  allowPinnedRelayOnly: true,
  minInstances: 1,
  maxInstances: 1,
  rejectUdp443: true,
  createdAt: existingServer?.createdAt || timestamp,
  updatedAt: timestamp,
};

const bonusServerIds = [
  SERVER_ID,
  ...originalBonus.filter((id) => id !== SERVER_ID),
];
const pinnedServerIds = [
  SERVER_ID,
  ...originalPinned.filter((id) => id !== SERVER_ID),
];
const updatedDayanch = {
  ...dayanch,
  bonusServerIds,
  pinnedServerIds,
  updatedAt: timestamp,
};

try {
  await upsertServer(SERVER_ID, server);
  await updateUser(dayanch.id, {
    bonusServerIds,
    pinnedServerIds,
    updatedAt: timestamp,
  });
  await upsertUserSubscriptionFile(updatedDayanch);

  const dayanchBody = await buildUserSubscriptionBody(updatedDayanch);
  const storedFile = await getFileByLinkedUserId(dayanch.id);
  const storedBody = plainSubscriptionContent(storedFile?.content);
  const firstVless = dayanchBody
    .split('\n')
    .find((line) => line.startsWith('vless://')) || '';
  if (
    !dayanchBody.includes(`@${EDGE_IP}:443`) ||
    !dayanchBody.includes(encodeURIComponent(WS_PATH)) ||
    !firstVless.includes(`@${EDGE_IP}:443`) ||
    !storedBody.includes(`@${EDGE_IP}:443`)
  ) {
    throw new Error('Gcore pilot is missing from generated/stored subscription or is not first');
  }

  const changedOtherUsers = [];
  for (const user of users) {
    if (String(user.id) === String(dayanch.id)) continue;
    const bodyAfter = await buildUserSubscriptionBody(user);
    if (bodyAfter !== bodiesBefore.get(String(user.id))) {
      changedOtherUsers.push(String(user.id));
    }
  }
  if (changedOtherUsers.length) {
    throw new Error(`Other subscriptions changed: ${changedOtherUsers.join(', ')}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        serverId: SERVER_ID,
        host: HOST,
        edgeIp: EDGE_IP,
        user: { id: dayanch.id, name: dayanch.name },
        firstServer: HOST,
        storedSubscriptionUpdated: true,
        otherUsersChanged: 0,
        addedToNewClients: false,
      },
      null,
      2
    )
  );
} catch (error) {
  const rollbackAt = nowIso();
  await updateUser(dayanch.id, {
    bonusServerIds: originalBonus,
    pinnedServerIds: originalPinned,
    updatedAt: rollbackAt,
  });
  await upsertUserSubscriptionFile({
    ...dayanch,
    bonusServerIds: originalBonus,
    pinnedServerIds: originalPinned,
    updatedAt: rollbackAt,
  });
  await upsertServer(SERVER_ID, {
    ...server,
    enabled: false,
    subscriptionHidden: true,
    addToNewClients: false,
    updatedAt: rollbackAt,
  });
  throw error;
}
