#!/usr/bin/env node
import { existsSync } from 'node:fs';

const appRoot = existsSync('/app/lib/db-store.js') ? 'file:///app/' : new URL('../', import.meta.url).href;
const [{ listUsers }, { getFileByLinkedUserId }, { buildUrlsForUser }] = await Promise.all([
  import(new URL('lib/firestore.js', appRoot).href),
  import(new URL('lib/files.js', appRoot).href),
  import(new URL('lib/user-urls.js', appRoot).href),
]);

const now = Date.now();
const users = (await listUsers(10000)).filter((user) => {
  if (!user?.uuid || user.enabled === false) return false;
  const expiry = Date.parse(user.expiresAt || user.expiryAt || '');
  return !Number.isFinite(expiry) || expiry > now;
});
const markers = [
  'manage.fastly.com',
  'painfully-super-puma.global.ssl.fastly.net',
  '@199.232.247.140:443',
  '@199.232.247.142:443',
  '@151.101.1.194:443',
];
const failures = [];
let verified = 0;
for (const user of users) {
  try {
    const file = await getFileByLinkedUserId(user.id);
    const urls = await buildUrlsForUser(user, file);
    const response = await fetch(urls.panelSubscriptionUrl || urls.panelFileUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Codex-No-Fastly-Verify/1.0' },
    });
    const raw = await response.text();
    const body = raw.includes('vless://')
      ? raw
      : Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const found = markers.filter((marker) => body.includes(marker));
    if (response.status !== 200 || found.length) failures.push({ userId: user.id, status: response.status, found });
    else verified += 1;
  } catch (error) {
    failures.push({ userId: user.id, error: error?.message || String(error) });
  }
}
if (failures.length) {
  console.error(JSON.stringify({ ok: false, checked: users.length, verified, failures: failures.slice(0, 10) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: users.length, verified, fastlyLinesPerUser: 0 }, null, 2));
