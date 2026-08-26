#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUrlsForUser } from '../lib/user-urls.js';

const now = Date.now();
const users = (await listUsers(10000)).filter((user) => {
  if (!user?.uuid || user.enabled === false) return false;
  const expiry = Date.parse(user.expiresAt || user.expiryAt || '');
  return !Number.isFinite(expiry) || expiry > now;
});

const failures = [];
let verified = 0;
for (const user of users) {
  try {
    const file = await getFileByLinkedUserId(user.id);
    const urls = await buildUrlsForUser(user, file);
    const liveUrl = urls.panelSubscriptionUrl || urls.panelFileUrl;
    const response = await fetch(liveUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Codex-Fastly-H2-Verify/1.0' },
    });
    const raw = await response.text();
    const body = raw.includes('vless://')
      ? raw
      : Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const h2Count = body.split('alpn=h2').length - 1;
    const h3Count = body.split('alpn=h3').length - 1;
    const addressCount = body.split('@199.232.247.142:443').length - 1;
    if (response.status !== 200 || h2Count < 3 || h3Count < 3 || addressCount < 6) {
      failures.push({ userId: user.id, status: response.status, h2Count, h3Count, addressCount });
    } else {
      verified += 1;
    }
  } catch (error) {
    failures.push({ userId: user.id, error: error?.message || String(error) });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, checked: users.length, verified, failures: failures.slice(0, 10) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  checked: users.length,
  verified,
  h2FastlyLinesPerUser: 3,
  h3FastlyLinesPerUser: 3,
}, null, 2));
