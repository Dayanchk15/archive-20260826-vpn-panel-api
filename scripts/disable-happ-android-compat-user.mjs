#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getUserById, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const user = await getUserById(process.argv[2]);
if (!user) throw new Error('User not found');
const timestamp = new Date().toISOString();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `disable-happ-android-compat-${user.id}-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  userId: user.id,
  previous: user.happAndroidCompatibility ?? null,
}, null, 2), 'utf8');
await updateUser(user.id, { happAndroidCompatibility: false, updatedAt: timestamp });
await upsertUserSubscriptionFile({ ...user, happAndroidCompatibility: false, updatedAt: timestamp });
console.log(JSON.stringify({
  ok: true,
  user: { id: user.id, name: user.name },
  happAndroidCompatibility: false,
  backupPath,
}, null, 2));
