#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const retireIp = String(process.env.RETIRE_SERVER_IP || '').trim();
if (!retireIp) throw new Error('RETIRE_SERVER_IP is required');
const dryRun = process.env.DRY_RUN === '1';
const users = (await listUsers(10000)).filter((u) => u.status !== 'disabled');
const stamp = nowIso();
const backupRoot = process.env.LOCAL_STORAGE_DIR || '/data/files';
const backupDir = path.join(backupRoot, 'backups');
await mkdir(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `retire-vps-${stamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: stamp,
  retireIp,
  users: users.map((u) => ({ id: u.id, extraSubscriptionLines: u.extraSubscriptionLines || [] })),
}, null, 2), { mode: 0o600 });

const result = { ok: true, dryRun, retireIp, usersChecked: users.length, usersChanged: 0, linesRemoved: 0, duplicatesRemoved: 0, backupPath };
for (const user of users) {
  const old = Array.isArray(user.extraSubscriptionLines) ? user.extraSubscriptionLines.map(String) : [];
  const next = [];
  const seen = new Set();
  for (const line of old) {
    if (line.includes(`@${retireIp}:`)) {
      result.linesRemoved++;
      continue;
    }
    if (seen.has(line)) {
      result.duplicatesRemoved++;
      continue;
    }
    seen.add(line);
    next.push(line);
  }
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    result.usersChanged++;
    if (!dryRun) {
      await updateUser(user.id, { extraSubscriptionLines: next, updatedAt: stamp });
      await upsertUserSubscriptionFile({ ...user, extraSubscriptionLines: next, updatedAt: stamp });
    }
  }
}

const panel = await getPanelSettings();
const oldGlobal = Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines.map(String) : [];
const nextGlobal = [];
const seenGlobal = new Set();
for (const line of oldGlobal) {
  if (line.includes(`@${retireIp}:`)) continue;
  if (seenGlobal.has(line)) continue;
  seenGlobal.add(line);
  nextGlobal.push(line);
}
if (!dryRun && JSON.stringify(oldGlobal) !== JSON.stringify(nextGlobal)) {
  await updatePanelSettings({ globalExtraSubscriptionLines: nextGlobal });
}
console.log(JSON.stringify(result, null, 2));
