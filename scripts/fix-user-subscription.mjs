#!/usr/bin/env node
/**
 * Fix a single user: assign visible servers, rotate subscription token (consistent hash), refresh sub.
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/fix-user-subscription.mjs Pon
 */
import { listUsers, getEnabledServerIds, updateUser } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { buildUrlsForUser } from '../lib/user-urls.js';
import { getPanelSettings } from '../lib/settings.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { nowIso } from '../lib/dates.js';
import { syncVpnEdgeClientsPhased, resolveWarmServerIds } from '../lib/vpn-edge-sync.js';

const nameQuery = (process.argv[2] || '').trim();
if (!nameQuery) {
  console.error('Usage: fix-user-subscription.mjs <userName>');
  process.exit(1);
}

const user = (await listUsers()).find(
  (u) => String(u.name || '').toLowerCase() === nameQuery.toLowerCase()
);
if (!user) {
  console.error(JSON.stringify({ ok: false, error: 'User not found' }));
  process.exit(1);
}

const serverIds = await getEnabledServerIds();
const token = randomToken();
const tokenHash = sha256(token);
const updatedAt = nowIso();

await updateUser(user.id, {
  serverIds,
  subscriptionToken: token,
  tokenHash,
  happEncryptedUrl: null,
  updatedAt,
});

const fixed = { id: user.id, name: user.name, ...user, serverIds, subscriptionToken: token, tokenHash };
const body = await buildAutoSubscription(fixed);
if (!String(body || '').trim()) {
  console.error(JSON.stringify({ ok: false, error: 'Subscription body still empty', serverIds }));
  process.exit(1);
}

await upsertUserSubscriptionFile(fixed);
const file = await getFileByLinkedUserId(user.id);
const panel = await getPanelSettings();
const urls = await buildUrlsForUser(fixed, file, panel);

let vpnEdgeSync = null;
try {
  const warmIds = await resolveWarmServerIds(serverIds);
  vpnEdgeSync = await syncVpnEdgeClientsPhased({ serverIds, priorityServerIds: warmIds });
} catch (err) {
  vpnEdgeSync = { ok: false, error: err.message };
}

console.log(
  JSON.stringify(
    {
      ok: true,
      user: user.name,
      serverCount: serverIds.length,
      bodyLines: body.split('\n').length,
      panelSubscriptionUrl: urls.panelSubscriptionUrl,
      panelFileUrl: urls.panelFileUrl,
      happEncryptedUrl: urls.happEncryptedUrl,
      subscriptionToken: token,
      vpnEdgeSync,
      hint: 'Клиенту: удалить старую подписку в Happ, импортировать новую happ://crypt… из панели.',
    },
    null,
    2
  )
);
