#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUrlsForUser } from '../lib/user-urls.js';

const now = Date.now();
const FASTLY_ADDRESS = String(process.env.FASTLY_ADDRESS || '199.232.247.142').trim();
const VERIFY_BASE_URL = String(process.env.VERIFY_BASE_URL || '').trim().replace(/\/+$/, '');
const users = (await listUsers(10000)).filter((user) => {
  if (!user?.uuid || user.enabled === false) return false;
  const expiry = Date.parse(user.expiresAt || user.expiryAt || '');
  return !Number.isFinite(expiry) || expiry > now;
});

const required = [
  `@${FASTLY_ADDRESS}:443`,
  'sni=manage.fastly.com',
  'host=painfully-super-puma.global.ssl.fastly.net',
  'alpn=h3',
  'mode=auto',
  'path=%2Ftampa%2F',
  'path=%2Ffornex%2F',
  'path=%2Ffr2%2F',
  '%F0%9F%87%BA%F0%9F%87%B8%20%D0%A1%D0%A8%D0%90',
  '%F0%9F%87%A9%F0%9F%87%AA%20%D0%93%D0%B5%D1%80%D0%BC%D0%B0%D0%BD%D0%B8%D1%8F',
  '%F0%9F%87%AB%F0%9F%87%B7%20%D0%A4%D1%80%D0%B0%D0%BD%D1%86%D0%B8%D1%8F',
];
const failures = [];
let verified = 0;
for (const user of users) {
  try {
    const file = await getFileByLinkedUserId(user.id);
    const urls = await buildUrlsForUser(user, file);
    const originalUrl = urls.panelSubscriptionUrl || urls.panelFileUrl;
    const liveUrl = VERIFY_BASE_URL
      ? `${VERIFY_BASE_URL}${new URL(originalUrl).pathname}${new URL(originalUrl).search}`
      : originalUrl;
    const response = await fetch(liveUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Codex-Fastly-TM-Verify/1.0' },
    });
    const body = await response.text();
    let decoded = body;
    if (!decoded.includes('vless://') && /^[A-Za-z0-9+/=_\r\n-]+$/.test(decoded.trim())) {
      decoded = Buffer.from(decoded.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    const missing = required.filter((value) => !decoded.includes(value));
    const addressCount = decoded.split(`@${FASTLY_ADDRESS}:443`).length - 1;
    const previousFastlyAddress = FASTLY_ADDRESS === '199.232.247.140'
      ? '199.232.247.142'
      : '199.232.247.140';
    const hasPreviousFastly = decoded.includes(`@${previousFastlyAddress}:443`);
    const hasLegacyFastly = decoded.includes('@151.101.1.194:443');
    if (response.status !== 200 || addressCount < 3 || missing.length || hasPreviousFastly || hasLegacyFastly) {
      failures.push({ userId: user.id, status: response.status, addressCount, missing, hasPreviousFastly, hasLegacyFastly });
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
console.log(JSON.stringify({ ok: true, checked: users.length, verified, tmFastlyLinesPerUser: 3 }, null, 2));
