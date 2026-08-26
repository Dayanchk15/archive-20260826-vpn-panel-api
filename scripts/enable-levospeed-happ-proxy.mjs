#!/usr/bin/env node
/**
 * Enable happ-proxy on levospeed.it.com and refresh all subscriptions.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/enable-levospeed-happ-proxy.mjs
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { resolveHappServerDescription } from '../lib/happ-subscription-controls.js';
import { nowIso } from '../lib/dates.js';

const LEVOSPEED_BASE = 'https://levospeed.it.com';
const panelBefore = await getPanelSettings();

const panel = await updatePanelSettings({
  subscriptionBaseUrl: LEVOSPEED_BASE,
  importUrlMode: 'api',
  happProxyEnabled: true,
  happHideSettings: true,
  happEncryptedSubscription: true,
  includeInfoRowsInStorage: false,
  happProviderId: panelBefore.happProviderId || 'W9zATxFb',
  happServerDescription:
    panelBefore.happServerDescription ||
    resolveHappServerDescription({ ...panelBefore, happProxyEnabled: true }),
});

let refreshed = 0;
let errors = 0;
const errorSamples = [];

for (const user of await listUsers()) {
  try {
    if (user.happEncryptedUrl) {
      await updateUser(user.id, { happEncryptedUrl: null, updatedAt: nowIso() });
    }
    await upsertUserSubscriptionFile(user);
    refreshed += 1;
  } catch (err) {
    errors += 1;
    if (errorSamples.length < 5) {
      errorSamples.push({ user: user.name || user.id, error: err.message || String(err) });
    }
  }
}

console.log(
  JSON.stringify(
    {
      ok: errors === 0,
      panel: {
        subscriptionBaseUrl: panel.subscriptionBaseUrl,
        happProxyEnabled: panel.happProxyEnabled,
        happProviderId: panel.happProviderId,
        happHideSettings: panel.happHideSettings,
        happEncryptedSubscription: panel.happEncryptedSubscription,
        happServerDescription: panel.happServerDescription,
      },
      usersTotal: refreshed + errors,
      refreshed,
      errors,
      errorSamples,
    },
    null,
    2
  )
);

process.exit(errors > 0 ? 1 : 0);
