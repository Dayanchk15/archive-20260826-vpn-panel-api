#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const panel = await updatePanelSettings({
  happWarningEnabled: false,
  happWarningText: '',
});

let refreshed = 0;
let errors = 0;
for (const user of await listUsers()) {
  try {
    await upsertUserSubscriptionFile(user);
    refreshed += 1;
  } catch (err) {
    errors += 1;
  }
}

console.log(
  JSON.stringify(
    {
      ok: errors === 0,
      happWarningEnabled: panel.happWarningEnabled,
      happWarningText: panel.happWarningText,
      usersRefreshed: refreshed,
      errors,
    },
    null,
    2
  )
);

process.exit(errors > 0 ? 1 : 0);
