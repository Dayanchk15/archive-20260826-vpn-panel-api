#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { deleteServer, listServers, listUsers, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const backupPath = '/tmp/disabled-server-records-backup.json';
const servers = await listServers();
const disabled = servers.filter((server) => server.enabled === false);
const disabledIds = new Set(disabled.map((server) => String(server.id)));
const users = await listUsers(5000);

writeFileSync(backupPath, JSON.stringify({ createdAt: nowIso(), servers: disabled }, null, 2));

let usersUpdated = 0;
let subscriptionsRefreshed = 0;
for (const user of users) {
  const serverIds = (user.serverIds || []).map(String).filter((id) => !disabledIds.has(id));
  const bonusServerIds = (user.bonusServerIds || []).map(String).filter((id) => !disabledIds.has(id));
  const pinnedServerIds = (user.pinnedServerIds || []).map(String).filter((id) => !disabledIds.has(id));
  const changed =
    serverIds.length !== (user.serverIds || []).length ||
    bonusServerIds.length !== (user.bonusServerIds || []).length ||
    pinnedServerIds.length !== (user.pinnedServerIds || []).length;
  const updatedAt = nowIso();
  if (changed) {
    await updateUser(user.id, { serverIds, bonusServerIds, pinnedServerIds, updatedAt });
    usersUpdated += 1;
  }
  await upsertUserSubscriptionFile({
    ...user,
    serverIds,
    bonusServerIds,
    pinnedServerIds,
    updatedAt,
  });
  subscriptionsRefreshed += 1;
}

for (const server of disabled) {
  await deleteServer(String(server.id));
}

const remaining = await listServers();
const remainingDisabled = remaining.filter((server) => server.enabled === false);
if (remainingDisabled.length) {
  throw new Error(`Disabled records remain: ${remainingDisabled.map((server) => server.id).join(', ')}`);
}

console.log(JSON.stringify({
  ok: true,
  deletedCount: disabled.length,
  deletedIds: disabled.map((server) => server.id),
  remainingCount: remaining.length,
  remainingEnabled: remaining.filter((server) => server.enabled !== false).length,
  usersUpdated,
  subscriptionsRefreshed,
  backupPath,
}, null, 2));
