#!/usr/bin/env node
/**
 * Safe plan step 1: panel-only (no GCP, no edge restart).
 * - Tampa sortOrder last (EU lines first in subscription)
 * - Sync relay server cpu/memory metadata in panel DB
 * - Refresh all subscription files (no live disconnect until client updates Happ)
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/apply-relay-plan-step1-sortorder.mjs
 */
import { listServers, upsertServer, listUsers, updateUser } from '../lib/db-store.js';
import { listEnabledRelayServerIds } from '../lib/relay-subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());

const TAMPA_SORT = Number(process.env.TAMPA_SORT_ORDER || 70);
const RELAY_CPU = Number(process.env.RELAY_CPU || 2);
const RELAY_MEMORY = String(process.env.RELAY_MEMORY || '2Gi');
const RELAY_MIN = Number(process.env.RELAY_MIN || 1);
const RELAY_MAX = Number(process.env.RELAY_MAX || 5);

const servers = await listServers();
const relayIds = await listEnabledRelayServerIds();

let serversPatched = 0;
for (const server of servers) {
  const isRelay =
    server.id === 'glb-vps-1' || String(server.id || '').startsWith('relay-eu-');
  if (!isRelay) continue;

  const patch = { updatedAt: nowIso() };
  if (server.id === 'glb-vps-1') {
    patch.sortOrder = TAMPA_SORT;
  }
  if (String(server.service || '') === 'relay-dayanch' || server.id === 'glb-vps-1') {
    patch.cpu = RELAY_CPU;
    patch.memory = RELAY_MEMORY;
    patch.minInstances = RELAY_MIN;
    patch.maxInstances = RELAY_MAX;
  }
  if (!DRY_RUN) await upsertServer(server.id, { ...server, ...patch });
  serversPatched += 1;
}

const orderedBonus = await listEnabledRelayServerIds();
let usersUpdated = 0;
let subsRefreshed = 0;

for (const user of await listUsers()) {
  const prev = JSON.stringify(user.bonusServerIds || []);
  const next = JSON.stringify(orderedBonus);
  if (prev !== next && !DRY_RUN) {
    await updateUser(user.id, { bonusServerIds: orderedBonus, updatedAt: nowIso() });
    usersUpdated += 1;
  } else if (prev !== next) {
    usersUpdated += 1;
  }

  const fresh = { ...user, bonusServerIds: orderedBonus };
  if (!DRY_RUN) {
    await upsertUserSubscriptionFile(fresh);
    subsRefreshed += 1;
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY_RUN,
      serversPatched,
      bonusOrder: orderedBonus,
      usersBonusReordered: usersUpdated,
      subscriptionsRefreshed: subsRefreshed,
      note: 'Live VPN unchanged until clients refresh subscription in Happ.',
    },
    null,
    2
  )
);
