#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { buildEdgeClientList } from '../lib/edge-clients.js';
import { listUsers } from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';

const serverIds = [
  'cloudflare-fr1-ws-pilot',
  'cloudflare-fr2-ws',
  'cloudflare-fornex-ws',
  'cloudflare-tampa-ws',
];

function fingerprint(uuids) {
  return createHash('sha256')
    .update(uuids.map((value) => String(value).toLowerCase()).sort().join(','))
    .digest('hex');
}

const clients = await buildEdgeClientList();
const users = (await listUsers(10000)).filter((user) => isUserActive(user));
const latest = [...users]
  .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  .slice(0, 5)
  .map((user) => ({
    id: user.id,
    name: user.name,
    createdAt: user.createdAt,
    uuidHash: createHash('sha256').update(String(user.uuid).toLowerCase()).digest('hex'),
    bonusHasAll: serverIds.every((id) => user.bonusServerIds?.map(String).includes(id)),
    pinnedHasAll: serverIds.every((id) => user.pinnedServerIds?.map(String).includes(id)),
    bonusFirstFour: (user.bonusServerIds || []).slice(0, 4),
  }));

console.log(JSON.stringify({
  activeUsers: users.length,
  edgeClients: clients.length,
  fingerprint: fingerprint(clients.map((client) => client.uuid)),
  latest,
}, null, 2));
