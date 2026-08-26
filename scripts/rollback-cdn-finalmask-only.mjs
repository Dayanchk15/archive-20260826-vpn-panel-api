#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { listUsers, upsertServer } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const BACKUP = process.env.BACKUP ||
  '/data/files/backups/cdn-finalmask-only-2026-07-17T09-20-46-974Z.json';
const APPLY = process.argv.includes('--apply');
const snapshot = JSON.parse(await readFile(BACKUP, 'utf8'));
const ids = Array.isArray(snapshot.ids) ? snapshot.ids.map(String) : [];
const servers = Array.isArray(snapshot.servers) ? snapshot.servers : [];
if (!ids.length || ids.length !== servers.length) throw new Error('Invalid CDN backup');

function lines(body) {
  return String(body || '').split(/\r?\n/).filter((line) => line.startsWith('vless://'));
}
function connection(line) { return String(line || '').split('#')[0]; }
function hostOf(line) {
  try { return new URL(line).searchParams.get('host') || ''; } catch { return ''; }
}

const users = await listUsers(10000);
const targetHosts = new Set(servers.map((server) => String(server.host || '')));
const before = new Map();
for (const user of users) before.set(String(user.id), await buildUserSubscriptionBody(user));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    backup: BACKUP,
    profilesToRestore: ids,
    usersToRefresh: users.length,
    relayProfilesToChange: 0,
  }, null, 2));
  process.exit(0);
}

for (let index = 0; index < ids.length; index += 1) {
  await upsertServer(ids[index], servers[index]);
}

let cdnLinks = 0;
for (const user of users) {
  const oldLines = lines(before.get(String(user.id)));
  const newLines = lines(await buildUserSubscriptionBody(user));
  if (oldLines.length !== newLines.length) throw new Error(`${user.id}: profile count changed`);

  const oldUntouched = oldLines.filter((line) => !targetHosts.has(hostOf(line))).map(connection);
  const newUntouched = newLines.filter((line) => !targetHosts.has(hostOf(line))).map(connection);
  if (JSON.stringify(oldUntouched) !== JSON.stringify(newUntouched)) {
    throw new Error(`${user.id}: relay or unrelated profile changed`);
  }
  cdnLinks += newLines.filter((line) => targetHosts.has(hostOf(line))).length;
}

for (const user of users) await upsertUserSubscriptionFile(user);

console.log(JSON.stringify({
  ok: true,
  profilesRestored: ids.length,
  subscriptionsRefreshed: users.length,
  cdnLinksPublished: cdnLinks,
  relayProfilesChanged: 0,
  profileCountsChanged: 0,
  backup: BACKUP,
}, null, 2));
