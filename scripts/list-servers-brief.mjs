#!/usr/bin/env node
import { listServers } from '../lib/db-store.js';
for (const s of (await listServers()).filter((x) => x.enabled !== false)) {
  console.log(
    [s.service, s.region, `min=${s.minInstances ?? 0}`, s.cloudRunProfileId || '-'].join('\t')
  );
}
