#!/usr/bin/env node
/**
 * Fix Test_Rustemaga: empty bonusServerIds → same relay lines as other users.
 *   docker exec vpn-panel-api-vps node /app/scripts/fix-test-rustemaga.mjs
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { listEnabledRelayServerIds } from '../lib/relay-subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { isUserActive } from '../lib/active-users.js';
import { nowIso } from '../lib/dates.js';

const NAME = process.env.FIX_USER_NAME || 'Test_Rustemaga';
const DRY_RUN = process.env.DRY_RUN === '1';

const users = await listUsers();
const user = users.find((u) => u.name === NAME);
if (!user) throw new Error(`User not found: ${NAME}`);

const relayIds = await listEnabledRelayServerIds();
const before = {
  id: user.id,
  status: user.status,
  relayOnly: user.relayOnly,
  bonusServerIds: user.bonusServerIds || [],
  uuid: user.uuid,
  active: isUserActive(user),
};

const needsBonus =
  !Array.isArray(user.bonusServerIds) ||
  !user.bonusServerIds.length ||
  JSON.stringify([...(user.bonusServerIds || [])].sort()) !== JSON.stringify([...relayIds].sort());

const patch = {
  bonusServerIds: relayIds,
  relayOnly: true,
  serverIds: [],
  updatedAt: nowIso(),
};

if (!DRY_RUN) {
  if (needsBonus || user.relayOnly !== true) {
    await updateUser(user.id, patch);
  }
  const fresh = { ...user, ...patch };
  await upsertUserSubscriptionFile(fresh);
}

const fresh = { ...user, ...patch };
const lines = (await buildAutoSubscription(fresh)).split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY_RUN,
      user: NAME,
      before,
      after: {
        bonusServerIds: relayIds,
        relayOnly: true,
        subscriptionLines: lines.length,
        firstLineHost: lines[0]?.match(/@([^?]+)/)?.[1] || null,
      },
      needsBonus,
    },
    null,
    2
  )
);
