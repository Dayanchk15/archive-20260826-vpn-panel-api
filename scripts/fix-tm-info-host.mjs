#!/usr/bin/env node
/**
 * Fix TM blocked hostname in info rows: set infoRowHost to www.google.com, refresh subs.
 */
import { listUsers } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { nowIso } from '../lib/dates.js';

const NEW_INFO_HOST = process.env.INFO_ROW_HOST || 'www.google.com';
const panel = await getPanelSettings();
const oldHost = panel.infoRowHost || 'unknown';

await updatePanelSettings({
  ...panel,
  infoRowHost: NEW_INFO_HOST,
  infoRowPort: Number(panel.infoRowPort || 80),
  importUrlMode: 'api',
  subscriptionBaseUrl: 'https://sub.twidu.com',
  connectionMode: 'masked',
  preferGcsDirectUrl: false,
  updatedAt: nowIso(),
});

let refreshed = 0;
let tronFound = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
  const file = await getFileByLinkedUserId(user.id);
  if (file?.content && /tron\.tm/i.test(file.content)) tronFound += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      infoRowHost: { old: oldHost, new: NEW_INFO_HOST },
      subscriptionsRefreshed: refreshed,
      filesStillContainingTronTm: tronFound,
    },
    null,
    2
  )
);
