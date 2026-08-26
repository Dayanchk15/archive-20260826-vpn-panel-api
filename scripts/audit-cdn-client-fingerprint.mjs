#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { buildEdgeClientList } from '../lib/edge-clients.js';

function fingerprint(values) {
  return createHash('sha256')
    .update(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean).sort().join(','))
    .digest('hex');
}

const clients = await buildEdgeClientList();
const uuids = clients.map((client) => client.uuid);

console.log(JSON.stringify({
  clients: uuids.length,
  fingerprint: fingerprint(uuids),
}));
