#!/usr/bin/env node
/** Switch panel connectionMode and refresh all subscriptions. */
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const mode = process.env.MODE || 'direct';
if (!['masked', 'direct'].includes(mode)) {
  console.error('MODE must be masked or direct'); process.exit(1);
}

const before = await getPanelSettings();
console.log(JSON.stringify({ before: before.connectionMode }));

await updatePanelSettings({ connectionMode: mode });

const after = await getPanelSettings();
console.log(JSON.stringify({ after: after.connectionMode }));

const users = await listUsers();
let n = 0;
for (const u of users) {
  await upsertUserSubscriptionFile(u);
  n++;
}
console.log(JSON.stringify({ subscriptionsRefreshed: n, mode, done: true }));
