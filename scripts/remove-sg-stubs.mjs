#!/usr/bin/env node
/** Remove broken singapore stubs (no host) and retry SG deploy prep. */
import { listServers, updateServer, deleteServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const removed = [];
for (const s of await listServers()) {
  if (!s.service?.startsWith('singapore')) continue;
  if (!String(s.host || '').trim()) {
    await updateServer(s.id, { enabled: false, updatedAt: nowIso() });
    await deleteServer(s.id);
    removed.push(s.service);
  }
}
console.log(JSON.stringify({ removed, remaining: (await listServers()).filter(x=>x.service?.startsWith('singapore')).map(x=>x.service) }));
