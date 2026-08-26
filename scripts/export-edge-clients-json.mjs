#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';

const output = process.argv[2] || '/tmp/edge-clients.json';
const clients = await buildEdgeClientList();
if (!clients.length) throw new Error('Edge client list is empty');
await writeFile(output, JSON.stringify(clients, null, 2), { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ ok: true, clients: clients.length, output }));
