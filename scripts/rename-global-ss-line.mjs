#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { listUsers } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const HOST = process.env.SS_HOST || '193.233.219.173';
const LABEL = process.env.SS_LABEL || '🇷🇺 Russia Fast';
const timestamp = nowIso();
const settings = await getPanelSettings();
const lines = Array.isArray(settings.globalExtraSubscriptionLines)
  ? settings.globalExtraSubscriptionLines.map(String)
  : [];
const index = lines.findIndex((line) => line.startsWith('ss://') && line.includes(HOST));
if (index < 0) throw new Error(`No global SS line for ${HOST} was found`);
const oldLine = lines[index];
const hash = oldLine.indexOf('#');
const encodedLabel = encodeURIComponent(LABEL);
const newLine = `${hash >= 0 ? oldLine.slice(0, hash) : oldLine}#${encodedLabel}`;
if (newLine === oldLine) {
  console.log(JSON.stringify({ ok: true, changed: false, label: LABEL, line: newLine }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `ss-label-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, globalExtraSubscriptionLines: lines }, null, 2), { mode: 0o600 });

const nextLines = [...lines];
nextLines[index] = newLine;
await updatePanelSettings({ globalExtraSubscriptionLines: nextLines });
const users = (await listUsers(10000)).filter((u) => u.status !== 'disabled');
for (const user of users) await upsertUserSubscriptionFile(user);
console.log(JSON.stringify({ ok: true, changed: true, label: LABEL, oldLine, newLine, updatedUsers: users.length, backupPath }, null, 2));
