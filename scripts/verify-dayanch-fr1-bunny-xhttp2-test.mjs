#!/usr/bin/env node
import { getServerById, getUserById, listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';

const SERVER_ID = 'bunny-fr1-xhttp2-dayanch';

function plain(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function findPilot(body) {
  const line = String(body).split(/\r?\n/).find((item) => item.includes('@94.20.154.22:443')) || '';
  if (!line) return null;
  const url = new URL(line);
  return {
    address: url.hostname,
    port: url.port,
    type: url.searchParams.get('type'),
    host: url.searchParams.get('host'),
    path: url.searchParams.get('path'),
    sni: url.searchParams.get('sni'),
    alpn: url.searchParams.get('alpn'),
    mode: url.searchParams.get('mode'),
    rejectUdp443: url.searchParams.get('xudpProxyUDP443'),
    hasFinalMask: Boolean(url.searchParams.get('fm')),
    remark: decodeURIComponent(line.split('#')[1] || ''),
  };
}

const [server, user, users, storedFile] = await Promise.all([
  getServerById(SERVER_ID),
  getUserById(DAYANCH_VIP_USER_ID),
  listUsers(10000),
  getFileByLinkedUserId(DAYANCH_VIP_USER_ID),
]);
if (!server || !user) throw new Error('Pilot server or Dayanch VIP is missing');

const generated = findPilot(await buildUserSubscriptionBody(user));
const stored = findPilot(plain(storedFile?.content));
const expected = {
  address: '94.20.154.22',
  port: '443',
  type: 'xhttp',
  host: 'levospeedfr1xhttp2.b-cdn.net',
  path: '/media/v4/fr1/sync',
  sni: 'levospeedfr1xhttp2.b-cdn.net',
  alpn: 'h2',
  mode: 'auto',
  rejectUdp443: 'reject',
  hasFinalMask: true,
};
for (const [key, value] of Object.entries(expected)) {
  if (generated?.[key] !== value || stored?.[key] !== value) {
    throw new Error(`Generated/stored pilot mismatch for ${key}`);
  }
}

const assignedOtherUsers = users.filter((item) =>
  String(item.id) !== String(user.id) &&
  [...(item.bonusServerIds || []), ...(item.pinnedServerIds || [])].map(String).includes(SERVER_ID)
);
if (assignedOtherUsers.length) throw new Error(`Pilot assigned to ${assignedOtherUsers.length} other users`);
if (String(user.bonusServerIds?.[0]) !== SERVER_ID || String(user.pinnedServerIds?.[0]) !== SERVER_ID) {
  throw new Error('Pilot is not pinned first for Dayanch VIP');
}

console.log(JSON.stringify({
  ok: true,
  user: user.name,
  serverId: SERVER_ID,
  generated,
  stored,
  assignedOtherUsers: 0,
  addToNewClients: server.addToNewClients,
  subscriptionEligible: server.subscriptionEligible,
}, null, 2));
