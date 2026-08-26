#!/usr/bin/env node
import { listUsers, updateServer, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const cloudflareIds = new Set(['cf-tampa', 'cf-fornex', 'cf-fr2']);
for (const id of cloudflareIds) {
  await updateServer(id, { enabled: false, addToNewClients: false, updatedAt: nowIso() });
}

let usersUpdated = 0;
let subscriptionsRefreshed = 0;
for (const user of await listUsers(5000)) {
  const bonusServerIds = (user.bonusServerIds || []).map(String).filter((id) => !cloudflareIds.has(id));
  const pinnedServerIds = (user.pinnedServerIds || []).map(String).filter((id) => !cloudflareIds.has(id));
  await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt: nowIso() });
  await upsertUserSubscriptionFile({ ...user, bonusServerIds, pinnedServerIds });
  usersUpdated += 1;
  subscriptionsRefreshed += 1;
}

console.log(JSON.stringify({ ok: true, disabled: [...cloudflareIds], usersUpdated, subscriptionsRefreshed }, null, 2));
