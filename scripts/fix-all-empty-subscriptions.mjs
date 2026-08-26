#!/usr/bin/env node
/**
 * Fix active users with empty auto subscription (relay-only without bonusServerIds).
 *   docker exec vpn-panel-api-vps node /app/scripts/fix-all-empty-subscriptions.mjs
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import {
  applyRelayUserDefaults,
  listEnabledRelayServerIds,
} from '../lib/relay-subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const panel = await getPanelSettings();
const relayIds = await listEnabledRelayServerIds();
const fixed = [];

for (const user of await listUsers()) {
  if (user.status !== 'active') continue;
  const body = await buildAutoSubscription(user);
  if (String(body || '').trim()) continue;

  const patch = await applyRelayUserDefaults(
    {
      bonusServerIds: relayIds,
      relayOnly: true,
      serverIds: [],
      updatedAt: nowIso(),
    },
    panel
  );

  if (!DRY_RUN) {
    await updateUser(user.id, patch);
    await upsertUserSubscriptionFile({ ...user, ...patch });
  }

  fixed.push({ id: user.id, name: user.name, uuid: user.uuid });
}

console.log(JSON.stringify({ ok: true, dryRun: DRY_RUN, fixedCount: fixed.length, fixed }, null, 2));
