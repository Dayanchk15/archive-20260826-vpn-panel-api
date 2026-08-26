#!/usr/bin/env node
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const ACTIVE_VERSION = 9;
const SERVER_IDS = [
  'tm-tampa-fastly-h3',
  'tm-fornex-fastly-h3',
  'tm-fr2-fastly-h3',
];

const servers = [];
for (const id of SERVER_IDS) {
  const server = await getServerById(id);
  if (!server) throw new Error(`Missing server ${id}`);
  servers.push({
    ...server,
    fastlyActiveVersion: ACTIVE_VERSION,
    ...(id === 'tm-fr2-fastly-h3'
      ? { fastlyOriginPort: 18444, fastlyBackendName: 'fr2_xhttp' }
      : {}),
    updatedAt: nowIso(),
  });
}

if (APPLY) {
  for (const server of servers) await upsertServer(server.id, server);
}

console.log(JSON.stringify({
  ok: true,
  applied: APPLY,
  fastlyActiveVersion: ACTIVE_VERSION,
  servers: servers.map(({ id, fastlyBackendName, fastlyOriginPort }) => ({
    id,
    fastlyBackendName: fastlyBackendName || null,
    fastlyOriginPort: fastlyOriginPort || null,
  })),
  userAssignmentsChanged: 0,
}, null, 2));
