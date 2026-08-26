#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUrlsForUser } from '../lib/user-urls.js';

const FASTLY_HOST = 'painfully-super-puma.global.ssl.fastly.net';
const now = Date.now();
const allActiveUsers = (await listUsers(10000)).filter((user) => {
  if (!user?.uuid || user.enabled === false) return false;
  const expiry = Date.parse(user.expiresAt || user.expiryAt || '');
  return !Number.isFinite(expiry) || expiry > now;
});
const limit = Math.max(0, Number(process.env.VERIFY_LIMIT || 0));
const users = limit ? allActiveUsers.slice(0, limit) : allActiveUsers;

const failures = [];
let verified = 0;
for (const user of users) {
  try {
    const file = await getFileByLinkedUserId(user.id);
    const urls = await buildUrlsForUser(user, file);
    const liveUrl = urls.panelSubscriptionUrl || urls.panelFileUrl;
    if (!liveUrl || !/^https:\/\//i.test(liveUrl)) {
      throw new Error('No HTTPS panel subscription URL');
    }
    const response = await fetch(liveUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Codex-Fastly-Rollout-Verify/1.0' },
    });
    const body = await response.text();
    let decoded = body;
    if (!decoded.includes('vless://') && /^[A-Za-z0-9+/=_\r\n-]+$/.test(decoded.trim())) {
      try {
        decoded = Buffer.from(decoded.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch {}
    }
    const hostCount = decoded.split(FASTLY_HOST).length - 1;
    const ok =
      response.status === 200 &&
      hostCount >= 4 &&
      decoded.includes('type=xhttp') &&
      decoded.includes('mode=packet-up') &&
      decoded.includes('path=%2Ftampa%2F') &&
      decoded.includes('path=%2Ffornex%2F');
    if (!ok) {
      failures.push({ userId: user.id, status: response.status, hostCount, bodyLength: body.length });
    } else {
      verified += 1;
    }
  } catch (error) {
    failures.push({
      userId: user.id,
      error: error?.message || String(error),
      cause: error?.cause?.code || error?.cause?.message || null,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, checked: users.length, verified, failures: failures.slice(0, 10) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: users.length, verified, fastlyHost: FASTLY_HOST }, null, 2));
