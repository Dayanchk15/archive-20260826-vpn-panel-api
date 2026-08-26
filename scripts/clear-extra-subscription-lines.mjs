#!/usr/bin/env node
/** Safely clear the panel's RAW/extra subscription lines without touching server records. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getUserById, listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { syncExtraSubscriptionFiles } from '../lib/extra-subscription-lines.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const users = await listUsers(10000);
const panel = await getPanelSettings();
const stamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `extra-subscription-lines-before-clear-${stamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: stamp,
  globalExtraSubscriptionLines: Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines : [],
  users: users.map((user) => ({ id: user.id, extraSubscriptionLines: Array.isArray(user.extraSubscriptionLines) ? user.extraSubscriptionLines : [] })),
}, null, 2), { mode: 0o600 });

await updatePanelSettings({ globalExtraSubscriptionLines: [] });
for (const user of users) {
  if (!Array.isArray(user.extraSubscriptionLines) || user.extraSubscriptionLines.length === 0) continue;
  await updateUser(user.id, { extraSubscriptionLines: [], updatedAt: stamp });
}

const sync = await syncExtraSubscriptionFiles(users, {
  reloadUser: getUserById,
  upsertSubscriptionFile: upsertUserSubscriptionFile,
  concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
});

console.log(JSON.stringify({
  ok: sync.failed === 0,
  users: users.length,
  clearedGlobal: Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines.length : 0,
  clearedUserLists: users.filter((user) => Array.isArray(user.extraSubscriptionLines) && user.extraSubscriptionLines.length > 0).length,
  refreshed: sync.refreshed,
  failed: sync.failed,
  backupPath,
}, null, 2));
