#!/usr/bin/env node
/** Refresh one user's stored subscription without rotating tokens or assignments. */
import { listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const query = String(process.argv[2] || '').trim().toLowerCase();
if (!query) throw new Error('usage: refresh-user-subscription-safe.mjs USER_NAME');
const users = await listUsers(10000);
const matches = users.filter((user) => String(user.name || '').trim().toLowerCase() === query);
if (matches.length !== 1) throw new Error(`expected one user, found ${matches.length}`);
const user = matches[0];
await upsertUserSubscriptionFile(user);
const body = String(await buildUserSubscriptionBody(user) || '');
const links = body.split(/\r?\n/).filter((line) => line.startsWith('vless://'));
const hosts = links.map((line) => {
  try { return new URL(line).searchParams.get('host') || ''; } catch { return ''; }
});
console.log(JSON.stringify({
  ok: true,
  userId: user.id,
  name: user.name,
  links: links.length,
  bunny: hosts.filter((host) => host.endsWith('.b-cdn.net')).length,
  cloudflare: hosts.filter((host) => host.endsWith('.levospeed.click')).length,
  relay: links.length - hosts.filter((host) => host.endsWith('.b-cdn.net') || host.endsWith('.levospeed.click')).length,
  tokenRotated: false,
  assignmentsChanged: false,
}));
