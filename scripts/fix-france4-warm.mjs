#!/usr/bin/env node
/** Make france4 warm (min=1) to fix 429 quota in europe-west9 alongside france3. */
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const servers = await listServers();
const target = servers.find(s => s.service === 'france4');
if (!target) { console.error('france4 not found'); process.exit(1); }

const patch = { minInstances: 1, maxInstances: 2, updatedAt: nowIso() };
await updateServer(target.id, patch);
console.log(JSON.stringify({ service: 'france4', ...patch }));

const result = await applyCloudRunServerPanelState({ ...target, ...patch });
console.log(JSON.stringify({ cloudRunUpdate: result }));
console.log('done');
