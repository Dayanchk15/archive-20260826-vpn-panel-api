#!/usr/bin/env node
/** Restore users serverIds + cloudRunProfiles from snapshot file. */
import { readFileSync } from 'fs';
import { listUsers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { setSetting, isPostgresEnabled } from '../lib/postgres.js';
import { nowIso } from '../lib/dates.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node rollback-infra-state.mjs /path/to/snapshot.json');
  process.exit(1);
}

const snap = JSON.parse(readFileSync(file, 'utf8'));
if (!snap.users || !Array.isArray(snap.users)) {
  throw new Error('Invalid snapshot: missing users');
}

let usersRestored = 0;
for (const row of snap.users) {
  const current = (await listUsers(10000)).find((u) => u.id === row.id);
  if (!current) continue;
  await updateUser(row.id, { serverIds: row.serverIds || [], updatedAt: nowIso() });
  await upsertUserSubscriptionFile({ ...current, serverIds: row.serverIds || [] });
  usersRestored += 1;
}

if (isPostgresEnabled() && snap.storedProfiles) {
  await setSetting('cloudRunProfiles', snap.storedProfiles);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      from: file,
      usersRestored,
      snapshotAt: snap.createdAt,
      note: 'Cloud Run GCP state not auto-reverted; re-run reconcile if needed',
    },
    null,
    2
  )
);
