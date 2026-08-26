#!/usr/bin/env node
import { listUsers, updateServer, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const serverId = 'worker-tampa-pilot';
await updateServer(serverId, {
  enabled: false,
  addToNewClients: false,
  newUsersOnly: true,
  updatedAt: nowIso(),
});

let usersUpdated = 0;
for (const user of await listUsers(5000)) {
  const bonusServerIds = (user.bonusServerIds || []).map(String).filter((id) => id !== serverId);
  const pinnedServerIds = (user.pinnedServerIds || []).map(String).filter((id) => id !== serverId);
  const changed =
    bonusServerIds.length !== (user.bonusServerIds || []).length ||
    pinnedServerIds.length !== (user.pinnedServerIds || []).length;
  if (changed) {
    const updatedAt = nowIso();
    await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt });
    await upsertUserSubscriptionFile({ ...user, bonusServerIds, pinnedServerIds, updatedAt });
    usersUpdated += 1;
  }
}

console.log(JSON.stringify({ ok: true, disabled: serverId, usersUpdated }, null, 2));
