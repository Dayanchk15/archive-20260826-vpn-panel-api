#!/usr/bin/env node
/** Refresh all user subscription files (new country-group sort order). */
import { listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const users = await listUsers(5000);
let ok = 0;
let failed = 0;
for (const user of users) {
  try {
    await upsertUserSubscriptionFile(user);
    ok += 1;
  } catch (err) {
    failed += 1;
    console.error(user.id, user.name, err.message || err);
  }
}
console.log(JSON.stringify({ ok: true, refreshed: ok, failed, total: users.length }, null, 2));
