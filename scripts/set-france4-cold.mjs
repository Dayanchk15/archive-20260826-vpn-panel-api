#!/usr/bin/env node
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const patch = { cpu: 1, memory: '1Gi', minInstances: 0, maxInstances: 2, updatedAt: nowIso() };
for (const svc of ['france4']) {
  const s = (await listServers()).find((x) => x.service === svc);
  await updateServer(s.id, patch);
  const r = await applyCloudRunServerPanelState({ ...s, ...patch });
  console.log(JSON.stringify({ service: svc, min: 0, ok: r.ok || r.skipped }));
}
for (const user of await listUsers()) await upsertUserSubscriptionFile(user);
