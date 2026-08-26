#!/usr/bin/env node
/** Refresh all user subscriptions after TCP relay path change. */
import { listUsers } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const users = await listUsers(10000);
let ok = 0;
let fail = 0;
for (const user of users) {
  try {
    await upsertUserSubscriptionFile(user);
    ok += 1;
  } catch (err) {
    fail += 1;
    console.error(user.id || user.email, err.message);
  }
}
console.log(JSON.stringify({ ok: true, users: users.length, refreshed: ok, failed: fail }));
