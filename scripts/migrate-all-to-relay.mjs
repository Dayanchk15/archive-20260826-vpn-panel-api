#!/usr/bin/env node
/**
 * Migrate all active users to Cloud Run relay subscription (pool lines removed).
 * Disables Happ fragmentation globally. Refreshes each user subscription file.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/migrate-all-to-relay.mjs
 *   DRY_RUN=1 — preview only
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { updatePanelSettings } from '../lib/settings.js';
import { listEnabledRelayServerIds } from '../lib/relay-subscription.js';
import { dedupeIdsPreserveOrder, resolveTmBonusServerIds } from '../lib/tm-shard.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';
import { REMOVED_RELAY_SERVER_IDS } from './eu-relay-dayanch/config.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const removed = new Set(REMOVED_RELAY_SERVER_IDS.map(String));

const relayIds = (await listEnabledRelayServerIds()).filter((id) => !removed.has(id));
if (!relayIds.length) {
  console.log(JSON.stringify({ ok: false, error: 'No enabled relay servers in panel' }));
  process.exit(1);
}

const bonusServerIds = relayIds;

if (!DRY_RUN) {
  await updatePanelSettings({
    subscriptionRelayOnly: true,
    happFragmentationEnabled: false,
    subscriptionTmShardEnabled: true,
  });
}

const users = await listUsers(10000);
let updated = 0;
let refreshed = 0;
const samples = [];

for (const user of users) {
  const nextBonus = dedupeIdsPreserveOrder(resolveTmBonusServerIds(user, relayIds, { subscriptionTmShardEnabled: true }));
  const needsUserUpdate =
    user.relayOnly !== true ||
    JSON.stringify(user.bonusServerIds || []) !== JSON.stringify(nextBonus);

  if (needsUserUpdate && !DRY_RUN) {
    await updateUser(user.id, {
      relayOnly: true,
      bonusServerIds: nextBonus,
      happEncryptedUrl: null,
      updatedAt: nowIso(),
    });
    updated += 1;
  } else if (needsUserUpdate) {
    updated += 1;
  }

  const fresh = {
    ...user,
    relayOnly: true,
    bonusServerIds: nextBonus,
    happEncryptedUrl: null,
  };

  if (!DRY_RUN) {
    await upsertUserSubscriptionFile(fresh);
    refreshed += 1;
  }

  if (samples.length < 3) {
    const body = await buildAutoSubscription(fresh);
    const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
    samples.push({ id: user.id, name: user.name, lines: lines.length });
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY_RUN,
      relayServerIds: bonusServerIds,
      usersTotal: users.length,
      usersUpdated: updated,
      subscriptionsRefreshed: refreshed,
      panel: { subscriptionRelayOnly: true, happFragmentationEnabled: false, subscriptionTmShardEnabled: true },
      samples,
      nextSteps: [
        'Rebuild/deploy vpn-ws-relay (WS ping keepalive)',
        'node scripts/install-eu-relay-edges.mjs with VLESS_CLIENTS_JSON from export-edge-clients.mjs',
      ],
    },
    null,
    2
  )
);
