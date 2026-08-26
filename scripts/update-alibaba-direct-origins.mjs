#!/usr/bin/env node
/**
 * Update Alibaba ESA server records from the old FR1 hub origin to per-server
 * direct origins. This does not change client-facing VLESS URLs; it only fixes
 * metadata used for CDN/origin operations and future rollouts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const DIRECT_ORIGIN_PORT = Number(process.env.ALIBABA_ESA_DIRECT_ORIGIN_PORT || 80);

const TARGETS = [
  ['alibaba-esa-fr1-daykoo', '185.209.230.14'],
  ['alibaba-esa-fr2-daykoo', '185.209.230.46'],
  ['alibaba-esa-fornex-daykoo', '130.17.12.61'],
  ['alibaba-esa-tampa-daykoo', '74.115.172.101'],
];

if (!Number.isInteger(DIRECT_ORIGIN_PORT) || DIRECT_ORIGIN_PORT < 1 || DIRECT_ORIGIN_PORT > 65535) {
  throw new Error(`Invalid ALIBABA_ESA_DIRECT_ORIGIN_PORT: ${DIRECT_ORIGIN_PORT}`);
}

const now = nowIso();
const before = [];
const serverPatches = [];
for (const [id, originAddress] of TARGETS) {
  const server = await getServerById(id);
  if (!server) continue;
  before.push(server);
  const next = {
    ...server,
    originAddress,
    originPort: DIRECT_ORIGIN_PORT,
    originMode: 'direct-per-origin',
    hubOriginAddress: server.hubOriginAddress || '185.209.230.14',
    hubOriginPort: server.hubOriginPort || 18108,
    hubNote: null,
    updatedAt: now,
  };
  if (
    server.originAddress !== next.originAddress ||
    server.originPort !== next.originPort ||
    server.originMode !== next.originMode ||
    server.hubNote
  ) {
    serverPatches.push(next);
  }
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    directOriginPort: DIRECT_ORIGIN_PORT,
    serverPatches: serverPatches.map((server) => ({
      id: server.id,
      host: server.host,
      originAddress: server.originAddress,
      originPort: server.originPort,
    })),
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `alibaba-direct-origins-${now.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  timestamp: now,
  directOriginPort: DIRECT_ORIGIN_PORT,
  before,
}, null, 2));

for (const server of serverPatches) await upsertServer(server.id, server);

invalidateSubscriptionBodyCache();
const users = await listUsers(10000);
let refreshedFiles = 0;
for (const user of users) {
  await upsertUserSubscriptionFile(user);
  refreshedFiles += 1;
}
invalidateSubscriptionBodyCache();

console.log(JSON.stringify({
  ok: true,
  applied: true,
  directOriginPort: DIRECT_ORIGIN_PORT,
  backupPath,
  serverPatches: serverPatches.map((server) => ({
    id: server.id,
    host: server.host,
    originAddress: server.originAddress,
    originPort: server.originPort,
  })),
  refreshedFiles,
}, null, 2));
