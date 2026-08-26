#!/usr/bin/env node
import { execSync } from 'child_process';
import { query, isPostgresEnabled } from '../lib/postgres.js';
import { listUsers } from '../lib/db-store.js';

const backup = process.env.BACKUP_PATH || '/opt/vpn-panel/backups/postgres/vpn_panel_20260623_020001.sql.gz';

function usersFromBackup() {
  const sql = execSync(`gunzip -c ${backup}`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const names = [];
  const copyMatch = sql.match(/COPY public\.users[^;]+FROM stdin;\n([\s\S]*?)\n\\\./);
  if (copyMatch) {
    for (const line of copyMatch[1].split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const data = parts[2] ? JSON.parse(parts[2]) : {};
      names.push({ id: parts[0], name: data.name, uuid: data.uuid, status: data.status });
    }
    return names;
  }
  return [];
}

const current = await listUsers(5000);
let backupUsers = [];
try {
  backupUsers = usersFromBackup();
} catch (err) {
  console.error('backup read failed:', err.message);
}

const currentIds = new Set(current.map((u) => u.id));
const backupIds = new Set(backupUsers.map((u) => u.id));
const missingNow = backupUsers.filter((u) => !currentIds.has(u.id));
const addedNow = current.filter((u) => !backupIds.has(u.id));

console.log(JSON.stringify({
  backupPath: backup,
  backupCount: backupUsers.length,
  currentCount: current.length,
  missingFromDb: missingNow,
  addedSinceBackup: addedNow.map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt })),
}, null, 2));

if (isPostgresEnabled()) {
  const audit = await query(
    `SELECT action, target_id, data, created_at
     FROM audit_log
     ORDER BY created_at DESC
     LIMIT 30`
  ).catch((e) => ({ rows: [], error: e.message }));
  console.log(JSON.stringify({ audit: audit.rows, auditError: audit.error }, null, 2));
}
