#!/usr/bin/env node
import {
  getServerById,
  getUserById,
  listUsers,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';

const SERVER_ID = 'bunny-az-fr2-video-pilot';

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function summarizeFirst(body) {
  const line = String(body).split('\n').find((value) => value.startsWith('vless://')) || '';
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
    rejectUdp443: url.searchParams.get('xudpProxyUDP443'),
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

const generated = await buildUserSubscriptionBody(user);
const stored = plainContent(storedFile?.content);
const generatedFirst = summarizeFirst(generated);
const storedFirst = summarizeFirst(stored);
const assignedOtherUsers = users.filter(
  (item) => String(item.id) !== String(user.id) &&
    [...(item.bonusServerIds || []), ...(item.pinnedServerIds || [])].map(String).includes(SERVER_ID)
);

const expected = {
  address: '94.20.154.22',
  port: '443',
  type: 'ws',
  host: 'levospeedfr2.b-cdn.net',
  path: '/bunny/fr2?ed=2560',
  sni: 'levospeedfr2.b-cdn.net',
  alpn: 'http/1.1',
  rejectUdp443: 'reject',
};
for (const [key, value] of Object.entries(expected)) {
  if (generatedFirst?.[key] !== value || storedFirst?.[key] !== value) {
    throw new Error(`Generated/stored first line mismatch for ${key}`);
  }
}
if (String(user.bonusServerIds?.[0]) !== SERVER_ID || String(user.pinnedServerIds?.[0]) !== SERVER_ID) {
  throw new Error('Pilot is not pinned first for Dayanch VIP');
}
if (assignedOtherUsers.length) throw new Error(`Pilot assigned to ${assignedOtherUsers.length} other users`);

console.log(JSON.stringify({
  ok: true,
  user: user.name,
  serverId: SERVER_ID,
  generatedFirst,
  storedFirst,
  assignedOtherUsers: 0,
  addToNewClients: server.addToNewClients,
  subscriptionEligible: server.subscriptionEligible,
}, null, 2));
