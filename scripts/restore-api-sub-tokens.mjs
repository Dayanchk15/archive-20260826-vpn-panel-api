#!/usr/bin/env node
/**
 * Mint subscriptionToken for users missing plaintext (panel was showing /f/slug instead of /api/sub/).
 */
import { listUsers } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { issueSubscriptionTokenIfMissing } from '../lib/subscription-token.js';

const panel = await getPanelSettings();
const importUrlMode = panel.importUrlMode || 'api';
if (importUrlMode !== 'api') {
  console.log(JSON.stringify({ ok: false, error: `importUrlMode is ${importUrlMode}, expected api` }));
  process.exit(1);
}

const users = await listUsers();
let rotated = 0;
let kept = 0;

for (const user of users) {
  const hadPlain = Boolean(String(user.subscriptionToken || '').trim());
  const { rotated: didRotate } = await issueSubscriptionTokenIfMissing(user);
  if (didRotate) rotated += 1;
  else if (hadPlain) kept += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      totalUsers: users.length,
      tokensRotated: rotated,
      tokensKept: kept,
      note: 'Users with rotated tokens must re-import subscription in Happ.',
    },
    null,
    2
  )
);
