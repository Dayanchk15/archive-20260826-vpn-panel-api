#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { syncRelayVpsEdges } from '../lib/relay-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { buildUserSubscriptionUrls } from '../lib/user-urls.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { probeMaskedTls } from '../lib/masked-tls-probe.js';
import { getServerById } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { buildEdgeClientList } from '../lib/edge-clients.js';

const arg = String(process.argv[2] || 'Wepa');
const users = await listUsers(5000);
const user = users.find((u) => u.id === arg) || users.find((u) => String(u.name || '').toLowerCase().includes(arg.toLowerCase()));
if (!user) {
  const amalLike = users.filter((u) => /amal|амал/i.test(u.name || ''));
  console.log(JSON.stringify({ ok: false, error: 'not found', arg, amalLike: amalLike.map((u) => u.name) }, null, 2));
  process.exit(1);
}

await upsertUserSubscriptionFile(user);
const sync = await syncRelayVpsEdges({ force: true });
const panel = await getPanelSettings();
const body = await buildUserSubscriptionBody(user);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
const edgeClients = await buildEdgeClientList();
const onEdge = edgeClients.some((c) => String(c.uuid).toLowerCase() === String(user.uuid).toLowerCase());
const nl = await getServerById('relay-eu-nl');
const probe = nl ? await probeMaskedTls(nl, panel.addressIps?.[0] || '216.58.198.50', 20000) : null;
const file = await getFileByLinkedUserId(user.id);
const urls = await buildUserSubscriptionUrls({ userId: user.id, token: user.subscriptionToken, subscriptionFile: file });

console.log(JSON.stringify({
  ok: true,
  user: { id: user.id, name: user.name, uuid: user.uuid, status: user.status, expiresAt: user.expiresAt },
  importUrl: `https://levospeed.it.com/api/sub/${user.subscriptionToken}`,
  happEncrypted: urls.subscriptionUrl?.startsWith('happ://'),
  lines: lines.length,
  uuidOnEdge: onEdge,
  relaySyncOk: sync.ok,
  relayEdgesFailed: (sync.edges || []).filter((e) => !e.ok),
  nlProbe: probe ? { ok: probe.ok, ms: probe.ms, error: probe.error } : null,
}, null, 2));
