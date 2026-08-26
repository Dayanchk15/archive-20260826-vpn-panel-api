#!/usr/bin/env node
/**
 * Restore original subscription token_hash from postgres backup (fixes broken /api/sub/ after migration).
 * Set Happ Provider ID, refresh all subscription files.
 *
 * Usage: docker exec vpn-panel-api-vps node /app/scripts/restore-token-hashes-and-provider.mjs
 */
import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { listUsers } from '../lib/db-store.js';
import { query } from '../lib/postgres.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const PROVIDER_ID = process.env.HAPP_PROVIDER_ID || 'W9zATxFb';
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/vpn-panel/backups/postgres';

function findLatestBackup() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.sql.gz'))
      .sort()
      .reverse();
    if (!files.length) return null;
    return `${BACKUP_DIR}/${files[0]}`;
  } catch {
    return process.env.BACKUP_PATH || null;
  }
}

function parseUsersFromBackup(backupPath) {
  const sql = execSync(`gunzip -c "${backupPath.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 120 * 1024 * 1024,
  });
  const m = sql.match(/COPY public\.users[^;]+FROM stdin;\n([\s\S]*?)\n\\\./);
  if (!m) throw new Error('users COPY block not found in backup');
  const map = new Map();
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const [id, tokenHash] = parts;
    if (id && tokenHash && tokenHash !== '\\N') {
      map.set(id, tokenHash);
    }
  }
  return map;
}

const backupPath = findLatestBackup();
if (!backupPath) {
  console.error(JSON.stringify({ ok: false, error: 'No postgres backup found' }));
  process.exit(1);
}

const backupHashes = parseUsersFromBackup(backupPath);
let hashesRestored = 0;
let clearedTokens = 0;
const restoreSamples = [];

for (const user of await listUsers()) {
  const backupHash = backupHashes.get(user.id);
  if (!backupHash) continue;

  const currentHash = user.tokenHash || null;
  const needsHashRestore = backupHash !== currentHash;
  const hasWrongPlainToken = Boolean(user.subscriptionToken);

  if (!needsHashRestore && !hasWrongPlainToken && !user.happEncryptedUrl) {
    continue;
  }

  const data = { ...user };
  delete data.id;
  delete data.tokenHash;
  delete data.upload_bytes;
  delete data.download_bytes;
  delete data.traffic_updated_at;

  if (hasWrongPlainToken || needsHashRestore) {
    delete data.subscriptionToken;
    delete data.happEncryptedUrl;
    clearedTokens += 1;
  }

  await query(
    `UPDATE users
     SET token_hash = $2,
         data = $3::jsonb,
         updated_at = $4
     WHERE id = $1`,
    [user.id, backupHash, JSON.stringify(data), nowIso()]
  );

  if (needsHashRestore) {
    hashesRestored += 1;
    if (restoreSamples.length < 5) {
      restoreSamples.push({ user: user.name || user.id, restored: true });
    }
  }

  await upsertUserSubscriptionFile({ id: user.id, ...data, tokenHash: backupHash });
}

const panel = await updatePanelSettings({
  happProviderId: PROVIDER_ID,
  happHideSettings: true,
  happEncryptedSubscription: true,
  includeInfoRowsInStorage: false,
  importUrlMode: 'api',
  updatedAt: nowIso(),
});

console.log(
  JSON.stringify(
    {
      ok: true,
      backupPath,
      providerId: panel.happProviderId || PROVIDER_ID,
      usersTotal: (await listUsers()).length,
      hashesRestored,
      clearedStaleTokens: clearedTokens,
      restoreSamples,
      hint: 'Старые /api/sub/ ссылки снова работают. В Happ: обновить подписку.',
    },
    null,
    2
  )
);
