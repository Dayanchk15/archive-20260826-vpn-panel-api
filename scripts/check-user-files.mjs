#!/usr/bin/env node
import { query } from '../lib/postgres.js';
import { listFiles } from '../lib/files.js';

const files = await listFiles();
const byUser = new Map();
const dupes = [];
for (const f of files) {
  if (!f.linkedUserId) continue;
  if (byUser.has(f.linkedUserId)) dupes.push({ userId: f.linkedUserId, files: [byUser.get(f.linkedUserId), f] });
  else byUser.set(f.linkedUserId, f);
}

const usersNoFile = await query(
  `SELECT u.id, u.data->>'name' as name FROM users u
   LEFT JOIN files f ON f.linked_user_id = u.id
   WHERE f.id IS NULL`
);
const orphanFiles = await query(
  `SELECT f.id, f.slug, f.linked_user_id FROM files f
   LEFT JOIN users u ON u.id = f.linked_user_id
   WHERE f.linked_user_id IS NOT NULL AND u.id IS NULL`
);

console.log(JSON.stringify({
  fileCount: files.length,
  linkedFiles: byUser.size,
  duplicateLinkedUser: dupes,
  usersWithoutFile: usersNoFile.rows,
  orphanFiles: orphanFiles.rows,
}, null, 2));
