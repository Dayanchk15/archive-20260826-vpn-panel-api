#!/usr/bin/env node
/**
 * Update Tencent EdgeOne server records from the old FR1 path-hub metadata to
 * per-server direct origin metadata. Client-facing VLESS URLs stay unchanged.
 *
 * Actual Tencent EdgeOne must also have Origin Rules configured:
 *   /eo/v1/4bfa6f260da5* -> 185.209.230.14:18108
 *   /eo/v1/a91c2e7b4d08* -> 185.209.230.46:18108
 *   /eo/v1/c3f8a1d92e44* -> 130.17.12.61:18108
 *   /eo/v1/e7b4d01a6c29* -> 74.115.172.101:18108
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { invalidateSubscriptionBodyCache } from '../lib/subscription-body-cache.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const DIRECT_ORIGIN_PORT = Number(process.env.TENCENT_DIRECT_ORIGIN_PORT || 18109);

const TARGETS = [
  ['tencent-edgeone-fr1-daykoo', '185.209.230.14'],
  ['tencent-edgeone-fr2-daykoo', '185.209.230.46'],
  ['tencent-edgeone-fornex-daykoo', '130.17.12.61'],
  ['tencent-edgeone-tampa-daykoo', '74.115.172.101'],
];

if (!Number.isInteger(DIRECT_ORIGIN_PORT) || DIRECT_ORIGIN_PORT < 1 || DIRECT_ORIGIN_PORT > 65535) {
  throw new Error(`Invalid TENCENT_DIRECT_ORIGIN_PORT: ${DIRECT_ORIGIN_PORT}`);
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
    hubHost: null,
    hubNote: null,
    updatedAt: now,
  };
  if (
    server.originAddress !== next.originAddress ||
    server.originPort !== next.originPort ||
    server.originMode !== next.originMode ||
    server.hubHost ||
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
      originMode: server.originMode,
    })),
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `tencent-direct-origins-${now.replace(/[:.]/g, '-')}.json`);
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
    originMode: server.originMode,
  })),
  refreshedFiles,
}, null, 2));
