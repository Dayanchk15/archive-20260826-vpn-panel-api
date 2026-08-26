import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, getUserById, updateUser } from '../lib/db-store.js';
import { normalizeExtraSubscriptionLines } from '../lib/extra-subscription-lines.js';
import { syncExtraSubscriptionFiles } from '../lib/extra-subscription-lines.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const TARGET_HOST = '46.226.162.95';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = process.env.BACKUP_DIR || '/data/files/backups';
const backupPath = path.join(backupDir, `remove-germany-vless-tcp-${stamp}.json`);

function isTarget(line) {
  const value = String(line || '').trim();
  if (!value.startsWith('vless://')) return false;
  if (!new RegExp(`@${TARGET_HOST.replaceAll('.', '\\.')}(?::443)(?:[/?#]|$)`, 'i').test(value)) return false;
  let remark = value.split('#')[1] || '';
  try { remark = decodeURIComponent(remark); } catch {}
  return /Germany/i.test(remark);
}

const users = await listUsers(10000);
const changed = [];
for (const user of users) {
  const oldLines = normalizeExtraSubscriptionLines(user.extraSubscriptionLines);
  const nextLines = oldLines.filter((line) => !isTarget(line));
  if (nextLines.length === oldLines.length) continue;
  changed.push({ id: user.id, name: user.name || '', removed: oldLines.filter(isTarget), before: oldLines, after: nextLines });
  await updateUser(user.id, { extraSubscriptionLines: nextLines, updatedAt: new Date().toISOString() });
}

await mkdir(backupDir, { recursive: true });
await writeFile(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), target: `${TARGET_HOST}:443 Germany`, changed }, null, 2), { mode: 0o600 });

const sync = await syncExtraSubscriptionFiles(changed, {
  reloadUser: getUserById,
  upsertSubscriptionFile: upsertUserSubscriptionFile,
  concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
});
console.log(JSON.stringify({ ok: true, changedUsers: changed.length, removedLines: changed.reduce((n, item) => n + item.removed.length, 0), synced: sync.refreshed, syncFailed: sync.failed, backupPath }));
