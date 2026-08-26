#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { listUsers } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const inputPath = process.env.SS_PUBLISH_FILE || '/app/scripts/ss-publish.json';
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const link = String(input.link || '').trim();
const server = String(input.server || '').trim();
const port = Number(input.port || 0);
if (!link.startsWith('ss://') || !server || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid SS publish payload');
}

const users = await listUsers(10000);
const panel = await getPanelSettings();
const oldGlobal = Array.isArray(panel.globalExtraSubscriptionLines)
  ? panel.globalExtraSubscriptionLines.map(String)
  : [];
const stamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `shared-ss-${stamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: stamp, globalExtraSubscriptionLines: oldGlobal }, null, 2), { mode: 0o600 });

// Replace only a previous shared SS line for this exact VPS/port. All other
// subscription lines, including VLESS and per-user lines, remain untouched.
const nextGlobal = oldGlobal.filter((line) => !(line.startsWith('ss://') && line.includes(`@${server}:${port}`)));
if (!nextGlobal.includes(link)) nextGlobal.push(link);

try {
  await updatePanelSettings({ globalExtraSubscriptionLines: nextGlobal });
  for (const user of users.filter((item) => item.status !== 'disabled')) {
    // Global lines are appended by the subscription builder. Refresh the
    // materialized file so clients do not wait for the next scheduled refresh.
    await upsertUserSubscriptionFile({ ...user, updatedAt: stamp });
  }
  console.log(JSON.stringify({
    ok: true,
    publishedToActiveClients: users.filter((item) => item.status !== 'disabled').length,
    replacedFor: `${server}:${port}`,
    backupPath,
  }, null, 2));
} catch (error) {
  await updatePanelSettings({ globalExtraSubscriptionLines: oldGlobal }).catch(() => {});
  throw new Error(`${error.message}; panel settings rolled back; backup: ${backupPath}`);
}
