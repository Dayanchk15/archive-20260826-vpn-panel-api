#!/usr/bin/env node
import { listServers } from '../lib/db-store.js';

const servers = (await listServers()).filter((s) => s.enabled !== false && s.host);
const results = [];
for (const s of servers.slice(0, 8)) {
  const host = s.host.replace(/^https?:\/\//, '');
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    results.push({
      service: s.service || s.name,
      host,
      status: res.status,
      ms: Date.now() - started,
      body: body.slice(0, 80),
    });
  } catch (err) {
    results.push({
      service: s.service || s.name,
      host,
      error: err.message,
      ms: Date.now() - started,
    });
  }
}
const all429 = results.every((r) => r.status === 429);
console.log(JSON.stringify({ all429, results }, null, 2));
