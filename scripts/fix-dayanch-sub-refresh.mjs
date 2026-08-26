#!/usr/bin/env node
/** Fix subscription refresh URL for TM: levospeed base + Dayanch only refresh. */
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { listUsers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const LEVOSPEED = 'https://levospeed.it.com';
const DAYANCH_ID = 'usr_bnjXUy4O1NZufeqW';

await updatePanelSettings({
  subscriptionBaseUrl: LEVOSPEED,
  importUrlMode: 'api',
});

const dayanch = (await listUsers()).find((u) => u.id === DAYANCH_ID);
if (dayanch) {
  await updateUser(DAYANCH_ID, {
    happEncryptedUrl: null,
    happHideSettings: false,
    happEncryptedSubscription: false,
    updatedAt: nowIso(),
  });
  await upsertUserSubscriptionFile({ ...dayanch, happEncryptedUrl: null });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      subscriptionBaseUrl: LEVOSPEED,
      dayanchRefreshed: Boolean(dayanch),
      note: 'Restart panel container if routes/subscription.js was updated',
    },
    null,
    2
  )
);
