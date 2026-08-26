import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { listUsers } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const previous = (await getPanelSettings()).subscriptionBaseUrl || null;
const next = 'https://levospeed.it.com';
await updatePanelSettings({ subscriptionBaseUrl: next, importUrlMode: 'api', preferGcsDirectUrl: false });
const users = await listUsers(10000);
for (const user of users) await upsertUserSubscriptionFile(user);
console.log(JSON.stringify({ ok: true, previousSubscriptionBaseUrl: previous, subscriptionBaseUrl: next, refreshedSubscriptions: users.length }, null, 2));
