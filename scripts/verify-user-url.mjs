#!/usr/bin/env node
import { getUserById } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUrlsForUser } from '../lib/user-urls.js';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: verify-user-url.mjs <userId>');
  process.exit(1);
}

const user = await getUserById(userId);
if (!user) {
  console.log(JSON.stringify({ ok: false, error: 'User not found' }));
  process.exit(1);
}

const file = await getFileByLinkedUserId(user.id);
const urls = await buildUrlsForUser(user, file);
console.log(
  JSON.stringify(
    {
      ok: true,
      name: user.name,
      tokenLen: user.subscriptionToken?.length || 0,
      subscriptionUrl: urls.subscriptionUrl,
      isApiSub: String(urls.subscriptionUrl || '').includes('/api/sub/'),
    },
    null,
    2
  )
);
