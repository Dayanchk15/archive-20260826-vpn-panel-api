#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';

const clients = await buildEdgeClientList();
const hashes = clients.map((client) =>
  createHash('sha256').update(String(client.uuid).trim().toLowerCase()).digest('hex')
).sort();
console.log(JSON.stringify({ count: hashes.length, hashes }));
