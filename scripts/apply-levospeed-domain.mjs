#!/usr/bin/env node
/**
 * Switch subscription base URL to levospeed.it.com and refresh all user links.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/apply-levospeed-domain.mjs
 */
import { listUsers } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';
import { updateUser } from '../lib/db-store.js';

const NEW_BASE = String(process.env.NEW_BASE || 'https://levospeed.it.com')
  .trim()
  .replace(/\/+$/, '');
if (![
  'https://levospeed.it.com',
  'https://www.levospeed.it.com',
  'https://painfully-super-puma.global.ssl.fastly.net',
].includes(NEW_BASE)) {
  throw new Error(`Unsupported subscription base URL: ${NEW_BASE}`);
}

const panel = await getPanelSettings();
await updatePanelSettings({
  subscriptionBaseUrl: NEW_BASE,
  importUrlMode: 'api',
  happProxyEnabled: panel.happProxyEnabled ?? false,
});

let refreshed = 0;
for (const user of await listUsers()) {
  await upsertUserSubscriptionFile(user);
  if (user.happEncryptedUrl) {
    await updateUser(user.id, { happEncryptedUrl: null, updatedAt: nowIso() });
  }
  refreshed += 1;
}

const sample = (await listUsers())[0];
const { buildUrlsForUser } = await import('../lib/user-urls.js');
const { getFileByLinkedUserId } = await import('../lib/files.js');
const urls = sample ? await buildUrlsForUser(sample, await getFileByLinkedUserId(sample.id), await getPanelSettings()) : null;

console.log(
  JSON.stringify(
    {
      ok: true,
      previousSubscriptionBaseUrl: panel.subscriptionBaseUrl || null,
      subscriptionBaseUrl: NEW_BASE,
      usersRefreshed: refreshed,
      sampleUrlHost: urls?.panelSubscriptionUrl ? new URL(urls.panelSubscriptionUrl).host : null,
    },
    null,
    2
  )
);
