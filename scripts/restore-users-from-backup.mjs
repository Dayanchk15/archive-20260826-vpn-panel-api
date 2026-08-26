#!/usr/bin/env node
/**
 * Restore users from postgres backup (COPY users section).
 * Usage: BACKUP_PATH=/tmp/backup.sql.gz RESTORE_IDS=usr_xxx,usr_yyy node scripts/restore-users-from-backup.mjs
 */
import { execSync } from 'child_process';
import { query } from '../lib/postgres.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';

const backup = process.env.BACKUP_PATH || '/tmp/backup.sql.gz';
const restoreIds = (process.env.RESTORE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseUsersFromBackup() {
  const sql = execSync(`gunzip -c ${backup}`, { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
  const m = sql.match(/COPY public\.users[^;]+FROM stdin;\n([\s\S]*?)\n\\\./);
  if (!m) throw new Error('users COPY block not found in backup');
  const rows = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const [id, tokenHash, dataRaw, createdAt, updatedAt] = parts;
    rows.push({
      id,
      tokenHash: tokenHash === '\\N' ? null : tokenHash,
      data: JSON.parse(dataRaw),
      createdAt,
      updatedAt,
    });
  }
  return rows;
}

const backupUsers = parseUsersFromBackup();
const targets = restoreIds.length
  ? backupUsers.filter((u) => restoreIds.includes(u.id))
  : backupUsers;

const restored = [];
const skipped = [];

for (const row of targets) {
  const exists = await query('SELECT id FROM users WHERE id = $1', [row.id]);
  if (exists.rows.length) {
    skipped.push({ id: row.id, name: row.data.name, reason: 'already_exists' });
    continue;
  }

  await query(
    `INSERT INTO users (id, token_hash, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [row.id, row.tokenHash, JSON.stringify(row.data), row.createdAt, row.updatedAt]
  );

  const user = { id: row.id, ...row.data };
  await upsertUserSubscriptionFile(user);
  restored.push({ id: row.id, name: row.data.name, uuid: row.data.uuid, status: row.data.status });
}

let sync = null;
if (restored.length) {
  try {
    sync = await syncVpnEdgeClients();
  } catch (err) {
    sync = { ok: false, error: err.message || String(err) };
  }
}

console.log(JSON.stringify({ ok: true, restored, skipped, sync }, null, 2));
