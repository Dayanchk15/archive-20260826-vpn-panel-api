#!/usr/bin/env node
/** Restore the cleanup backup while removing exact duplicate subscription lines. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getUserById, listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { normalizeExtraSubscriptionLines, syncExtraSubscriptionFiles } from '../lib/extra-subscription-lines.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const backupPath = process.env.EXTRA_LINES_BACKUP ||
  '/data/files/backups/extra-subscription-lines-before-clear-2026-08-18T19-21-24-987Z.json';
const backup = JSON.parse(await readFile(path.resolve(backupPath), 'utf8'));
const panel = await getPanelSettings();
const globalLines = normalizeExtraSubscriptionLines(backup.globalExtraSubscriptionLines);
await updatePanelSettings({ globalExtraSubscriptionLines: globalLines });

let originalUserLines = 0;
let restoredUserLines = 0;
let removedDuplicates = 0;
for (const row of Array.isArray(backup.users) ? backup.users : []) {
  const original = Array.isArray(row.extraSubscriptionLines) ? row.extraSubscriptionLines : [];
  const unique = normalizeExtraSubscriptionLines(original);
  originalUserLines += original.length;
  restoredUserLines += unique.length;
  removedDuplicates += original.length - unique.length;
  await updateUser(row.id, { extraSubscriptionLines: unique });
}

const users = await listUsers(10000);
const sync = await syncExtraSubscriptionFiles(users, {
  reloadUser: getUserById,
  upsertSubscriptionFile: upsertUserSubscriptionFile,
  concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
});

console.log(JSON.stringify({
  ok: sync.failed === 0,
  globalLines: globalLines.length,
  originalUserLines,
  restoredUserLines,
  removedDuplicates,
  refreshed: sync.refreshed,
  failed: sync.failed,
  previousGlobalLines: Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines.length : 0,
}, null, 2));
