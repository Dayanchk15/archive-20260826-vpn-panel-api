#!/usr/bin/env node
import { upsertServer, getServerById } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('Usage: node scripts/clear-server-hosts.mjs server-33 ...');
  process.exit(1);
}

for (const id of ids) {
  const existing = await getServerById(id);
  if (!existing) {
    console.log(JSON.stringify({ id, skipped: true, reason: 'not found' }));
    continue;
  }
  await upsertServer(id, { host: '', updatedAt: nowIso() });
  console.log(JSON.stringify({ id, cleared: true, service: existing.service }));
}
