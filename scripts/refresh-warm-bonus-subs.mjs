#!/usr/bin/env node
/**
 * Refresh all user subscriptions after warm-only bonus fix.
 *   docker exec vpn-panel-api-vps node /app/scripts/refresh-all-subscriptions-sort.mjs
 */
import { listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';

const users = await listUsers(5000);
let refreshed = 0;
let sampleLines = null;

for (const user of users) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

const sample = users.find((u) => u.dealerId && u.status === 'active') || users[0];
if (sample) {
  const body = await buildUserSubscriptionBody(sample);
  sampleLines = body.split('\n').filter((l) => l.startsWith('vless://')).length;
}

console.log(JSON.stringify({ ok: true, refreshed, sampleUser: sample?.name, sampleLines }, null, 2));
