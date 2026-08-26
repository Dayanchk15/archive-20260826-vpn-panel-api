#!/usr/bin/env node
/**
 * Enable Happ manual server settings for Dayanch VIP only.
 * Does NOT change panel-wide happHideSettings / encrypted links for other clients.
 */
import { getUserById, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUrlsForUser } from '../lib/user-urls.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const VIP_ID = 'usr_bnjXUy4O1NZufeqW';

const user = await getUserById(VIP_ID);
if (!user) {
  console.log(JSON.stringify({ ok: false, error: 'Dayanch VIP not found' }));
  process.exit(1);
}

await updateUser(VIP_ID, {
  happHideSettings: false,
  happEncryptedSubscription: false,
  happEncryptedUrl: null,
  updatedAt: nowIso(),
});

const fresh = {
  ...user,
  happHideSettings: false,
  happEncryptedSubscription: false,
  happEncryptedUrl: null,
};

await upsertUserSubscriptionFile(fresh);
const file = await getFileByLinkedUserId(VIP_ID);
const panel = await getPanelSettings();
const urls = await buildUrlsForUser(fresh, file, panel);

console.log(
  JSON.stringify(
    {
      ok: true,
      user: { id: fresh.id, name: fresh.name },
      happHideSettings: false,
      happEncryptedSubscription: false,
      panelSubscriptionUrl: urls.panelSubscriptionUrl,
      happEncryptedUrl: urls.happEncryptedUrl || null,
      otherClientsUnchanged: true,
      hint: 'Dayanch VIP: обновить подписку в Happ — появятся ручные настройки серверов.',
    },
    null,
    2
  )
);
