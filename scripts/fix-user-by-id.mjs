#!/usr/bin/env node
/** Fix user by id: refresh sub + force relay edge sync */
import { getUserById, listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile, refreshUserSubscriptionAndEdge } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionUrls } from '../lib/user-urls.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';

const idOrName = process.argv[2];
let user = null;
if (idOrName?.startsWith('usr_')) {
  user = await getUserById(idOrName);
} else {
  const q = String(idOrName || '').toLowerCase();
  user = (await listUsers(5000)).find((u) => String(u.name || '').toLowerCase().includes(q));
}
if (!user) {
  console.log(JSON.stringify({ ok: false, error: 'not found' }));
  process.exit(1);
}

const refreshed = await refreshUserSubscriptionAndEdge(user);
const file = await getFileByLinkedUserId(user.id);
const urls = await buildUserSubscriptionUrls({
  userId: user.id,
  token: user.subscriptionToken,
  subscriptionFile: file,
});
const body = await buildUserSubscriptionBody(user);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      ok: true,
      name: user.name,
      uuid: user.uuid,
      lines: lines.length,
      relayEdgeSync: refreshed.relayEdgeSync,
      plainUrl: urls.plainSubscriptionUrl || urls.panelSubscriptionUrl,
      levospeed: urls.subscriptionBaseUrl
        ? `${urls.subscriptionBaseUrl}/api/sub/${user.subscriptionToken}`
        : null,
      firstLine: lines[0]?.slice(0, 180),
    },
    null,
    2
  )
);
