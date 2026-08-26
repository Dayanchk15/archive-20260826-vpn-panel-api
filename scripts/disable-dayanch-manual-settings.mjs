#!/usr/bin/env node
/**
 * Restore Happ hide-settings + encrypted link for Dayanch VIP (panel defaults).
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
  happHideSettings: null,
  happEncryptedSubscription: null,
  updatedAt: nowIso(),
});

const fresh = { ...user };
delete fresh.happHideSettings;
delete fresh.happEncryptedSubscription;

await upsertUserSubscriptionFile(fresh);
const file = await getFileByLinkedUserId(VIP_ID);
const panel = await getPanelSettings();
const urls = await buildUrlsForUser(fresh, file, panel);

console.log(JSON.stringify({ ok: true, restoredPanelDefaults: true, happEncryptedUrl: urls.happEncryptedUrl || null }, null, 2));
