#!/usr/bin/env node
import { listUsers, updateServer, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const serverId = 'pilot-fr1-tcp';
await updateServer(serverId, {
  enabled: false,
  addToNewClients: false,
  newUsersOnly: true,
  subscriptionHidden: true,
  updatedAt: nowIso(),
});

let usersUpdated = 0;
let subscriptionsRefreshed = 0;
for (const user of await listUsers(5000)) {
  const bonusServerIds = (user.bonusServerIds || []).map(String).filter((id) => id !== serverId);
  const pinnedServerIds = (user.pinnedServerIds || []).map(String).filter((id) => id !== serverId);
  const changed =
    bonusServerIds.length !== (user.bonusServerIds || []).length ||
    pinnedServerIds.length !== (user.pinnedServerIds || []).length;
  const updatedAt = nowIso();
  if (changed) {
    await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt });
    usersUpdated += 1;
  }
  await upsertUserSubscriptionFile({ ...user, bonusServerIds, pinnedServerIds, updatedAt });
  subscriptionsRefreshed += 1;
}

console.log(JSON.stringify({
  ok: true,
  disabled: serverId,
  usersUpdated,
  subscriptionsRefreshed,
}, null, 2));
