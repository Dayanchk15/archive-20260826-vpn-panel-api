#!/usr/bin/env node
/** Recover only each client's own bundle keys from the pre-cleanup backup. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getUserById, listUsers, updateUser } from '../lib/db-store.js';
import { updatePanelSettings } from '../lib/settings.js';
import { normalizeExtraSubscriptionLines, syncExtraSubscriptionFiles } from '../lib/extra-subscription-lines.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const backupPath = process.env.EXTRA_LINES_BACKUP ||
  '/data/files/backups/extra-subscription-lines-before-clear-2026-08-18T19-21-24-987Z.json';
const bundleIp = String(process.env.BUNDLE_IP || '81.31.245.113').trim();
const ssPortBase = Number(process.env.SS_PORT_BASE || 20002);
const backup = JSON.parse(await readFile(path.resolve(backupPath), 'utf8'));
const allCandidates = normalizeExtraSubscriptionLines([
  ...(Array.isArray(backup.globalExtraSubscriptionLines) ? backup.globalExtraSubscriptionLines : []),
  ...(Array.isArray(backup.users) ? backup.users.flatMap((u) => u.extraSubscriptionLines || []) : []),
]);
const users = (await listUsers(10000)).filter((u) => u.status !== 'disabled');
const vlessFor = (uuid) => allCandidates.filter((line) => {
  const match = String(line).match(/^vless:\/\/([^@]+)@([^:?#]+):(\d+)/i);
  return match && match[1].toLowerCase() === String(uuid || '').toLowerCase() && match[2] === bundleIp;
});
const ssAt = (port) => allCandidates.find((line) => {
  const match = String(line).match(/^ss:\/\/[^@]+@([^:?#]+):(\d+)/i);
  return match && match[1] === bundleIp && Number(match[2]) === port;
});

const assignments = users.map((user, index) => {
  const ownVless = vlessFor(user.uuid);
  const ownSs = ssAt(ssPortBase + index);
  return { user, lines: normalizeExtraSubscriptionLines([ownSs, ...ownVless]), ss: Boolean(ownSs), vless: ownVless.length };
});
const missing = assignments.filter((x) => !x.ss || x.vless === 0);
if (process.env.DRY_RUN === '1') {
  console.log(JSON.stringify({
    ok: missing.length === 0,
    bundleIp,
    candidateLines: allCandidates.length,
    users: assignments.length,
    assignedLines: assignments.reduce((n, x) => n + x.lines.length, 0),
    ssAssigned: assignments.filter((x) => x.ss).length,
    vlessAssigned: assignments.reduce((n, x) => n + x.vless, 0),
    ...(process.env.DEBUG_ASSIGN === '1' ? {
      assignments: assignments.map((x, index) => ({ index, name: x.user.name, id: x.user.id, ss: x.ss, expectedPort: ssPortBase + index, vless: x.vless })),
    } : {}),
    missing: missing.map((x) => ({ name: x.user.name, ss: x.ss, vless: x.vless })),
  }, null, 2));
  process.exit(missing.length ? 2 : 0);
}

await updatePanelSettings({ globalExtraSubscriptionLines: [] });
for (const item of assignments) await updateUser(item.user.id, { extraSubscriptionLines: item.lines });
const sync = await syncExtraSubscriptionFiles(users, {
  reloadUser: getUserById,
  upsertSubscriptionFile: upsertUserSubscriptionFile,
  concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
});
console.log(JSON.stringify({
  ok: sync.failed === 0 && missing.length === 0,
  bundleIp,
  users: assignments.length,
  assignedLines: assignments.reduce((n, x) => n + x.lines.length, 0),
  ssAssigned: assignments.filter((x) => x.ss).length,
  vlessAssigned: assignments.reduce((n, x) => n + x.vless, 0),
  missing: missing.map((x) => ({ name: x.user.name, ss: x.ss, vless: x.vless })),
  refreshed: sync.refreshed,
  failed: sync.failed,
}, null, 2));
