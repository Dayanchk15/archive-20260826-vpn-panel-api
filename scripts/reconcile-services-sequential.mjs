#!/usr/bin/env node
import { listServers, updateServer } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const services = process.argv.slice(2);
const WAIT_MS = Number(process.env.WAIT_MS || 45000);
const WARM = 'germany8';

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

const servers = (await listServers()).filter((s) => s.cloudRunProfileId === 'gcp-euphoric');
for (const svc of services) {
  const server = servers.find((s) => s.service === svc);
  if (!server) {
    console.log(JSON.stringify({ service: svc, ok: false, error: 'not found' }));
    continue;
  }
  const patch = {
    minInstances: server.service === WARM ? 1 : 0,
    maxInstances: 2,
    cpu: 1,
    memory: '1Gi',
    updatedAt: nowIso(),
  };
  await updateServer(server.id, patch);
  const fix = await applyCloudRunServerPanelState({ ...server, ...patch });
  console.log(JSON.stringify({ service: svc, ok: Boolean(fix.ok || fix.skipped), message: fix.message || fix.error }));
  await sleep(WAIT_MS);
}