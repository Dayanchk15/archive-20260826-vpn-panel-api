#!/usr/bin/env node
/**
 * Enable Happ privacy for all clients: hide-settings, encrypted links, no info rows.
 * Refresh every user subscription file.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/refresh-all-happ-privacy.mjs
 */
import { listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { resolveHappServerDescription } from '../lib/happ-subscription-controls.js';
import { nowIso } from '../lib/dates.js';

const panelBefore = await getPanelSettings();
const brand = String(panelBefore.brandName || 'GGspeed').trim();
const serverDescription = resolveHappServerDescription({
  ...panelBefore,
  happServerDescription: panelBefore.happServerDescription || 'Secure',
});

const panel = await updatePanelSettings({
  happProviderId: panelBefore.happProviderId || 'W9zATxFb',
  happHideSettings: true,
  happEncryptedSubscription: true,
  includeInfoRowsInStorage: false,
  happServerDescription: serverDescription,
  updatedAt: nowIso(),
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
        happHideSettings: panel.happHideSettings !== false,
        happEncryptedSubscription: panel.happEncryptedSubscription !== false,
        includeInfoRowsInStorage: panel.includeInfoRowsInStorage === true,
        happServerDescription: panel.happServerDescription || serverDescription,
      },
      usersTotal: refreshed + errors,
      refreshed,
      errors,
      errorSamples,
      clientHint:
        'Клиентам: обновить подписку в Happ. Подпись VLESS WS TLS заменяется на Secure при Provider ID.',
    },
    null,
    2
  )
);

process.exit(errors > 0 ? 1 : 0);
