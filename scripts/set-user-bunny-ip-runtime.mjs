#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getUserById,
  listServers,
  updateUser,
} from '/app/lib/db-store.js';
import {
  CDN_PROVIDER_BUNNY,
  classifyCdnServer,
  applyCdnAddressOverrides,
} from '/app/lib/cdn-address-ips.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const userId = String(process.argv[2] || '').trim();
const bunnyIp = String(process.argv[3] || '').trim();
const apply = process.argv.includes('--apply');

if (!userId) throw new Error('User ID is required');
if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bunnyIp)) throw new Error('Valid Bunny IPv4 is required');

const user = await getUserById(userId);
if (!user) throw new Error(`User not found: ${userId}`);

const allServers = await listServers();
const selectedIds = new Set(
  ['serverIds', 'bonusServerIds', 'pinnedServerIds']
    .flatMap((field) => (Array.isArray(user[field]) ? user[field] : []))
    .map(String)
);
const bunnyServers = allServers.filter(
  (server) =>
    selectedIds.has(String(server.id)) &&
    server.enabled !== false &&
    classifyCdnServer(server) === CDN_PROVIDER_BUNNY
);
if (!bunnyServers.length) throw new Error(`${user.name || user.id} has no selected Bunny servers`);

const beforeBody = await buildUserSubscriptionBody(user);
const beforeLines = String(beforeBody).split(/\r?\n/).filter(Boolean);
const isBunnyLine = (line) => {
  try {
    const parsed = new URL(line);
    return String(parsed.searchParams.get('host') || '').includes('b-cdn.net');
  } catch {
    return false;
  }
};
const beforeNonBunny = beforeLines.filter((line) => !isBunnyLine(line));

const applied = applyCdnAddressOverrides(user.serverAddressIps, bunnyServers, {
  [CDN_PROVIDER_BUNNY]: bunnyIp,
});
const timestamp = nowIso();
const patch = {
  serverAddressIps: applied.serverAddressIps,
  updatedAt: timestamp,
};

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    user: { id: user.id, name: user.name },
    bunnyIp,
    bunnyServerIds: bunnyServers.map((server) => server.id),
    changedServerIds: applied.changedServerIds,
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(
  backupRoot,
  `user-bunny-ip-${user.id}-${timestamp.replace(/[:.]/g, '-')}.json`
);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: user.id,
  previousServerAddressIps: user.serverAddressIps || {},
}, null, 2));

try {
  await updateUser(user.id, patch);
  const updatedUser = { ...user, ...patch };
  await upsertUserSubscriptionFile(updatedUser);

  const afterBody = await buildUserSubscriptionBody(updatedUser);
  const afterLines = String(afterBody).split(/\r?\n/).filter(Boolean);
  const afterNonBunny = afterLines.filter((line) => !isBunnyLine(line));
  if (JSON.stringify(afterNonBunny) !== JSON.stringify(beforeNonBunny)) {
    throw new Error('Non-Bunny subscription lines changed');
  }

  const bunnyLines = afterLines.filter(isBunnyLine);
  if (bunnyLines.length !== bunnyServers.length) {
    throw new Error(`Expected ${bunnyServers.length} Bunny lines, generated ${bunnyLines.length}`);
  }
  const wrongIps = bunnyLines.filter((line) => {
    try {
      return new URL(line).hostname !== bunnyIp;
    } catch {
      return true;
    }
  });
  if (wrongIps.length) throw new Error(`${wrongIps.length} Bunny lines do not use ${bunnyIp}`);

  console.log(JSON.stringify({
    ok: true,
    user: { id: user.id, name: user.name },
    bunnyIp,
    bunnyServerIds: bunnyServers.map((server) => server.id),
    bunnyLines: bunnyLines.length,
    nonBunnyLinesUnchanged: true,
    backupPath,
  }, null, 2));
} catch (error) {
  const rollback = {
    serverAddressIps: user.serverAddressIps || {},
    updatedAt: nowIso(),
  };
  await updateUser(user.id, rollback).catch(() => {});
  await upsertUserSubscriptionFile({ ...user, ...rollback }).catch(() => {});
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
