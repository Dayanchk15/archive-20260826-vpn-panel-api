#!/usr/bin/env node
import { listServers } from '../lib/db-store.js';
const servers = (await listServers()).filter((s) => s.enabled !== false);
for (const s of servers) {
  console.log(
    [s.service || s.name, `min=${s.minInstances ?? 0}`, `max=${s.maxInstances ?? 1}`, `cpu=${s.cpu ?? 1}`, `mem=${s.memory || '512Mi'}`, s.cloudRunProfileId || '-'].join(' ')
  );
}
