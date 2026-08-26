import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { listUsers } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const panel = await getPanelSettings();
const previous = panel.subscriptionBaseUrl || null;
const next = 'https://sub.twidu.com';
await updatePanelSettings({ subscriptionBaseUrl: next, importUrlMode: 'api', preferGcsDirectUrl: false });

const users = await listUsers(10000);
let refreshed = 0;
for (const user of users) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
}

console.log(JSON.stringify({
  ok: true,
  previousSubscriptionBaseUrl: previous,
  subscriptionBaseUrl: next,
  refreshedSubscriptions: refreshed,
}, null, 2));
