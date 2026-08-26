#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, upsertServer } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const APPLY = process.argv.includes('--apply');
const IDS = [
  'bunny-fr1-current-edge-dayanch',
  'bunny-az-fr2-pilot',
  'bunny-az-fornex-pilot',
  'bunny-az-tampa-pilot',
  'bunny-az-fr1-pilot',
  'cloudflare-finalmask-tampa-dayanch',
  'cloudflare-finalmask-fr1-dayanch',
  'cloudflare-finalmask-fornex-dayanch',
  'cloudflare-fr2-finalmask-dayanch',
];
const FRAGMENTATION = {
  enabled: true,
  packets: 'tlshello',
  length: '2',
  interval: '0-1',
  maxSplit: '3-6',
};

function lines(body) {
  return String(body || '').split(/\r?\n/).filter((line) => line.startsWith('vless://'));
}
function connection(line) { return String(line || '').split('#')[0]; }
function urlOf(line) { try { return new URL(line); } catch { return null; } }
function hostOf(line) { return urlOf(line)?.searchParams.get('host') || ''; }

const [users, servers] = await Promise.all([
  listUsers(10000),
  Promise.all(IDS.map((id) => getServerById(id))),
]);
const missing = IDS.filter((_, index) => !servers[index]);
if (missing.length) throw new Error(`Missing CDN profiles: ${missing.join(', ')}`);
const targetHosts = new Set(servers.map((server) => String(server.host || '')));
const beforeBodies = new Map();
for (const user of users) beforeBodies.set(String(user.id), await buildUserSubscriptionBody(user));

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    profiles: IDS,
    fragment: '2,0-1,tlshello',
    maxSplitStored: '3-6',
    usersToRefresh: users.length,
    relayProfilesToChange: 0,
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `cdn-legacy-fragment-only-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, ids: IDS, servers }, null, 2), 'utf8');

let applied = 0;
async function rollback() {
  for (let index = 0; index < applied; index += 1) {
    await upsertServer(IDS[index], servers[index]).catch(() => {});
  }
  for (const user of users) await upsertUserSubscriptionFile(user).catch(() => {});
}

try {
  for (let index = 0; index < IDS.length; index += 1) {
    await upsertServer(IDS[index], {
      ...servers[index],
      finalMask: null,
      fragmentation: FRAGMENTATION,
      updatedAt: timestamp,
    });
    applied += 1;
  }

  let cdnLinksVerified = 0;
  for (const user of users) {
    const before = lines(beforeBodies.get(String(user.id)));
    const after = lines(await buildUserSubscriptionBody(user));
    if (before.length !== after.length) throw new Error(`${user.id}: profile count changed`);

    const beforeUntouched = before.filter((line) => !targetHosts.has(hostOf(line))).map(connection);
    const afterUntouched = after.filter((line) => !targetHosts.has(hostOf(line))).map(connection);
    if (JSON.stringify(beforeUntouched) !== JSON.stringify(afterUntouched)) {
      throw new Error(`${user.id}: relay or unrelated profile changed`);
    }

    for (const line of after.filter((item) => targetHosts.has(hostOf(item)))) {
      const url = urlOf(line);
      if (url.searchParams.has('fm')) throw new Error(`${user.id}: fm remains for ${hostOf(line)}`);
      if (url.searchParams.get('fragment') !== '2,0-1,tlshello') {
        throw new Error(`${user.id}: legacy fragment missing for ${hostOf(line)}`);
      }
      if (url.searchParams.get('encryption') !== 'none') {
        throw new Error(`${user.id}: standard VLESS layout missing for ${hostOf(line)}`);
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
        throw new Error(`${user.id}: CDN address is not IPv4 for ${hostOf(line)}`);
      }
      cdnLinksVerified += 1;
    }
  }

  for (const user of users) await upsertUserSubscriptionFile(user);
  console.log(JSON.stringify({
    ok: true,
    profilesUpdated: IDS.length,
    subscriptionsRefreshed: users.length,
    cdnLinksVerified,
    fragment: '2,0-1,tlshello',
    maxSplitStored: '3-6',
    finalMaskRemovedFromCdn: true,
    relayProfilesChanged: 0,
    profileCountsChanged: 0,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
