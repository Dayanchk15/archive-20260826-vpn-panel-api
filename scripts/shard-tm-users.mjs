#!/usr/bin/env node
/**
 * Apply TM per-user relay sharding + refresh subscriptions.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/shard-tm-users.mjs
 *   DRY_RUN=1 docker exec vpn-panel-api-vps node /app/scripts/shard-tm-users.mjs
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { listEnabledRelayServerIds } from '../lib/relay-subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import {
  dedupeIdsPreserveOrder,
  hashUserShardIndex,
  resolveShardPoolFromAvailable,
  resolveTmBonusServerIds,
  shouldSkipTmShardForUser,
} from '../lib/tm-shard.js';
import { nowIso } from '../lib/dates.js';

const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());

const panel = await getPanelSettings();
const relayIds = await listEnabledRelayServerIds({ tmShardOrder: true });
if (!relayIds.length) {
  console.log(JSON.stringify({ ok: false, error: 'No enabled relay servers' }));
  process.exit(1);
}

if (!DRY_RUN && panel.subscriptionTmShardEnabled === false) {
  await updatePanelSettings({ subscriptionTmShardEnabled: true });
}

const pool = resolveShardPoolFromAvailable(relayIds);
const users = await listUsers(10000);
const distribution = Object.fromEntries(pool.map((id) => [id, 0]));
const rows = [];
let updated = 0;
let refreshed = 0;

for (const user of users) {
  const nextBonus = dedupeIdsPreserveOrder(resolveTmBonusServerIds(user, relayIds, panel));
  if (!nextBonus.length) continue;

  const primary = nextBonus[0];
  if (primary) distribution[primary] = (distribution[primary] || 0) + 1;

  const same =
    JSON.stringify(nextBonus) === JSON.stringify(dedupeIdsPreserveOrder(user.bonusServerIds || []));

  if (!same && !DRY_RUN) {
    await updateUser(user.id, {
      bonusServerIds: nextBonus,
      relayOnly: true,
      updatedAt: nowIso(),
    });
    updated += 1;
  } else if (!same) {
    updated += 1;
  }

  const fresh = { ...user, bonusServerIds: nextBonus, relayOnly: true };
  if (!DRY_RUN) {
    await upsertUserSubscriptionFile(fresh);
    refreshed += 1;
  }

  if (rows.length < 8) {
    const body = await buildAutoSubscription(fresh);
    const firstLine = body.split('\n').find((l) => l.startsWith('vless://')) || '';
    const remark = firstLine.includes('#') ? decodeURIComponent(firstLine.split('#')[1]) : '';
    rows.push({
      id: user.id,
      name: user.name,
      shardIndex: shouldSkipTmShardForUser(user, panel)
        ? null
        : hashUserShardIndex(user.id, pool.length),
      primary: nextBonus[0],
      remark,
      lines: body.split('\n').filter((l) => l.startsWith('vless://')).length,
    });
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY_RUN,
      pool,
      poolSize: pool.length,
      usersTotal: users.length,
      usersUpdated: updated,
      subscriptionsRefreshed: refreshed,
      distribution,
      avgPerShard: users.length / Math.max(pool.length, 1),
      samples: rows,
      panel: { subscriptionTmShardEnabled: true },
    },
    null,
    2
  )
);
