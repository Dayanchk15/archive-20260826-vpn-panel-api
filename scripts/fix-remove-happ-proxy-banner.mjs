#!/usr/bin/env node
/**
 * Remove Happ-proxy provider banner (#providerid) without touching VPN/relays.
 * Keeps hide-settings, encrypted import, serverDescription.
 */
import { listUsers } from '/app/lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { resolveHappProviderId } from '/app/lib/happ-subscription-controls.js';
import { nowIso } from '/app/lib/dates.js';

const before = await getPanelSettings();
await updatePanelSettings({
  happProviderId: '',
  happWarningEnabled: before.happWarningEnabled === true,
});
const after = await getPanelSettings();

let refreshed = 0;
let failed = 0;
for (const user of await listUsers(10000)) {
  try {
    await upsertUserSubscriptionFile(user);
    refreshed += 1;
  } catch (err) {
    failed += 1;
    console.error('refresh failed', user.id, err.message);
  }
}

const sampleUser = (await listUsers()).find((u) => u.status === 'active') || (await listUsers())[0];
const sampleFile = sampleUser ? await getFileByLinkedUserId(sampleUser.id) : null;
const head = String(sampleFile?.content || '').split('\n').slice(0, 12);

console.log(
  JSON.stringify(
    {
      ok: true,
      panel: {
        happProxyEnabled: after.happProxyEnabled,
        happProviderId: after.happProviderId,
        resolvedProviderId: resolveHappProviderId(after),
        happWarningEnabled: after.happWarningEnabled,
        happHideSettings: after.happHideSettings,
        happEncryptedSubscription: after.happEncryptedSubscription,
      },
      refreshed,
      failed,
      sampleHead: head,
      hasProviderIdLine: String(sampleFile?.content || '').includes('#providerid'),
      updatedAt: nowIso(),
    },
    null,
    2
  )
);
