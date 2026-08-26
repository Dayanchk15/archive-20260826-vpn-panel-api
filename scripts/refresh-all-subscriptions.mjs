#!/usr/bin/env node
/** Restart-safe refresh: all user subscription files + clear stale happ crypt URLs. */
import { listUsers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

let cleared = 0;
let refreshed = 0;
for (const user of await listUsers(10000)) {
  if (user.happEncryptedUrl) {
    await updateUser(user.id, { happEncryptedUrl: null, updatedAt: nowIso() });
    cleared += 1;
  }
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}
console.log(JSON.stringify({ ok: true, cleared, refreshed }, null, 2));
