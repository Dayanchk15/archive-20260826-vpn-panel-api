#!/usr/bin/env node
/**
 * TM fixes: warm 6 core nodes, subscription warm-only, fix tokens, refresh subs.
 */
import { listServers, listUsers, updateServer } from '../lib/db-store.js';
import { updatePanelSettings, getPanelSettings } from '../lib/settings.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { issueSubscriptionTokenIfMissing } from '../lib/subscription-token.js';
import { sha256 } from '../lib/crypto.js';
import { nowIso } from '../lib/dates.js';
import { acquireScriptLock } from '../lib/script-lock.mjs';

const TM_IP = '216.58.198.50';
const WARM_SERVICES = new Set([
  'germany13',
  'germany15',
  'germany16',
  'neth5',
  'neth8',
  'singapore2',
]);
const PAUSE_MS = Number(process.env.PAUSE_MS || 25000);

const lock = acquireScriptLock('heavy-vpn-ops', { staleMs: 3 * 60 * 60 * 1000 });
if (!lock.ok) {
  console.log(JSON.stringify({ skipped: true, reason: lock.reason }));
  process.exit(0);
}
process.on('exit', () => lock.release());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

await updatePanelSettings({
  connectionMode: 'masked',
  addressIps: [TM_IP],
  subscriptionBaseUrl: 'https://levospeed.it.com',
  importUrlMode: 'api',
  subscriptionWarmOnly: true,
});

const servers = (await listServers()).filter((s) => s.enabled !== false && s.tmPool !== false);
const warmResults = [];

for (const server of servers) {
  const warm = WARM_SERVICES.has(server.service);
  const patch = {
    addressIp: TM_IP,
    cpu: 2,
    memory: '2Gi',
    minInstances: warm ? 1 : 0,
    maxInstances: warm ? 2 : 1,
    updatedAt: nowIso(),
  };
  await updateServer(server.id, patch);
  const applied = await applyCloudRunServerPanelState({ ...server, ...patch });
  warmResults.push({
    service: server.service,
    warm,
    ok: Boolean(applied.ok || applied.skipped),
    message: applied.message || applied.error,
  });
  await sleep(PAUSE_MS);
}

let tokensFixed = 0;
let tokensRotated = 0;
for (const user of await listUsers()) {
  const existing = String(user.subscriptionToken || '').trim();
  const expected = existing ? sha256(existing) : null;
  const needsRotate = existing && user.tokenHash && user.tokenHash !== expected;
  const issued = await issueSubscriptionTokenIfMissing(user);
  if (issued.rotated || needsRotate) tokensRotated += 1;
  else if (!existing) tokensFixed += 1;
  await upsertUserSubscriptionFile(issued.user);
}

const sync = await syncVpnEdgeClients().catch((err) => ({ ok: false, error: err.message }));

console.log(
  JSON.stringify(
    {
      ok: true,
      warmServices: [...WARM_SERVICES],
      warmResults,
      subscriptionWarmOnly: true,
      tokensFixed,
      tokensRotated,
      users: (await listUsers()).length,
      sync,
    },
    null,
    2
  )
);
