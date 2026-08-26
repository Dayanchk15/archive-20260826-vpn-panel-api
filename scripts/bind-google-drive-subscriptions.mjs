#!/usr/bin/env node
/**
 * Bind existing Google Drive subscription files to the matching panel users.
 * This never creates, deletes, renames, or replaces Drive files.
 * Run with --apply to persist the stable Drive URL and file id in PostgreSQL.
 */
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId, updateFile } from '../lib/files.js';
import {
  configuredGoogleDriveUrl,
  listGoogleDriveFiles,
} from '../lib/google-drive.js';

const APPLY = process.argv.includes('--apply');

function normalizeName(value) {
  return String(value || '')
    .replace(/\.(txt|conf|json)$/i, '')
    .replace(/\s+[—-].*$/, '')
    .trim()
    .toLocaleLowerCase();
}

const users = await listUsers(10000);
const driveFiles = (await listGoogleDriveFiles()).filter(
  (file) => file?.mimeType === 'text/plain' && file?.id && file?.name
);
const byName = new Map();
for (const file of driveFiles) {
  const key = normalizeName(file.name);
  if (!key || byName.has(key)) continue;
  byName.set(key, file);
}

const result = { apply: APPLY, users: users.length, matched: 0, updated: 0, alreadyBound: 0, missing: [], extras: [] };
const matchedIds = new Set();
for (const user of users) {
  const driveFile = byName.get(normalizeName(user.name));
  if (!driveFile) {
    result.missing.push(user.name || user.id);
    continue;
  }
  result.matched += 1;
  matchedIds.add(driveFile.id);
  const existing = await getFileByLinkedUserId(user.id);
  if (!existing) {
    result.missing.push(`${user.name || user.id} (panel file missing)`);
    continue;
  }
  const stableUrl = await configuredGoogleDriveUrl(driveFile.id);
  const already = existing.driveFileId === driveFile.id && existing.publicStorageUrl === stableUrl;
  if (already) {
    result.alreadyBound += 1;
    continue;
  }
  if (APPLY) {
    await updateFile(existing.id, {
      driveFileId: driveFile.id,
      publicStorageUrl: stableUrl,
      storageUrl: stableUrl,
      linkedUserId: user.id,
    });
    result.updated += 1;
  }
}

result.extras = driveFiles
  .filter((file) => !matchedIds.has(file.id))
  .map((file) => file.name);
console.log(JSON.stringify(result, null, 2));
