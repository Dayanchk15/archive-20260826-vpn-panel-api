#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { syncRelayVpsEdges } from '../lib/relay-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionUrls } from '../lib/user-urls.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';

const arg = String(process.argv[2] || 'Amal');
const q = arg.toLowerCase();
let user = null;
if (arg.startsWith('usr_')) {
  user = (await listUsers(5000)).find((u) => u.id === arg);
} else {
  user = (await listUsers(5000)).find((u) => String(u.name || '').toLowerCase().includes(q));
}
if (!user) {
  console.log(JSON.stringify({ ok: false, error: 'user not found', q }));
  process.exit(1);
}

await upsertUserSubscriptionFile(user);
const sync = await syncRelayVpsEdges({ force: true });
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
      id: user.id,
      uuid: user.uuid,
      lines: lines.length,
      relaySync: { ok: sync.ok, clientCount: sync.clientCount, edges: sync.edges?.map((e) => ({ id: e.id, ok: e.ok, error: e.error })) },
      importUrl: `https://levospeed.it.com/api/sub/${user.subscriptionToken}`,
      panelSubscriptionUrl: urls.panelSubscriptionUrl,
      linesPreview: lines.map((l) => {
        const ip = (l.match(/@([^:]+):/) || [])[1];
        const host = (l.match(/host=([^&]+)/) || [])[1];
        const remark = decodeURIComponent((l.match(/#(.+)$/) || [])[1] || '').split('?')[0];
        return { ip, host: decodeURIComponent(host || ''), remark };
      }),
    },
    null,
    2
  )
);
