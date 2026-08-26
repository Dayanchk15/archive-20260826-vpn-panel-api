#!/usr/bin/env node
import { getUserById } from '/app/lib/db-store.js';
import { refreshUserSubscriptionAndEdge } from '/app/lib/user-subscription-file.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';

const user = await getUserById(process.argv[2]);
if (!user) throw new Error('User not found');
const refreshed = await refreshUserSubscriptionAndEdge(user);
const links = (await buildUserSubscriptionBody(user)).split(/\r?\n/).filter((line) => line.startsWith('vless://'));
console.log(JSON.stringify({
  ok: true,
  user: { id: user.id, name: user.name },
  links: links.length,
  vpnEdgeSyncOk: refreshed.vpnEdgeSync?.ok ?? null,
  relayEdgeSyncOk: refreshed.relayEdgeSync?.ok ?? null,
}, null, 2));
