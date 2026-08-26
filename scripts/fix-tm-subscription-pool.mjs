#!/usr/bin/env node
/**
 * Fix TM subscription: reorder, one-per-country, redeploy warm pool, refresh subs.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/fix-tm-subscription-pool.mjs
 */
import { listUsers } from '../lib/db-store.js';
import { listServers } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const WARM = new Set(['germany13', 'germany15', 'germany16', 'neth5', 'neth8', 'singapore2']);

await updatePanelSettings({
  subscriptionWarmOnly: true,
  subscriptionOnePerCountry: true,
});

const panel = await getPanelSettings();
const servers = (await listServers()).filter((s) => s.enabled !== false && WARM.has(s.service));

const fixes = [];
for (const server of servers) {
  try {
    const result = await applyCloudRunServerPanelState(server);
    fixes.push({ service: server.service, ok: result.ok, skipped: result.skipped });
  } catch (err) {
    fixes.push({ service: server.service, ok: false, error: err.message || String(err) });
  }
  await new Promise((r) => setTimeout(r, 12000));
}

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      panel: {
        subscriptionWarmOnly: panel.subscriptionWarmOnly,
        subscriptionOnePerCountry: panel.subscriptionOnePerCountry,
        cpuThrottlingEnv: process.env.CLOUD_RUN_CPU_THROTTLING ?? '(unset)',
      },
      warmRedeployed: fixes,
      usersRefreshed: refreshed,
      expectedServersInSub: 'Netherlands, Singapore, Germany (3)',
    },
    null,
    2
  )
);
