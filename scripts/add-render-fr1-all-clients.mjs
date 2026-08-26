#!/usr/bin/env node
/**
 * Add the Render FR1 WebSocket edge to every automatic subscription.
 * The node carries its own Happ/Xray FinalMask, so global fragmentation
 * settings (including Dayanch VIP's opt-out) are not changed.
 *
 * Run on the panel container:
 *   node /app/scripts/add-render-fr1-all-clients.mjs --dry-run
 *   node /app/scripts/add-render-fr1-all-clients.mjs --apply
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getServerById, listUsers, upsertServer, updateUser } from '/app/lib/db-store.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const SERVER_ID = 'render-fr1-ws';
const HOST = 'frren.aktamdyr.store';
const EDGE_IP = '216.24.57.1';
const timestamp = nowIso();

const node = {
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'France FR1',
  country: 'France',
  flag: '🇫🇷',
  host: HOST,
  sni: HOST,
  // Keep the Render hostname as the connect address; panel-level masked IPs
  // must not replace it with a direct/blocked address.
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  strictAddressIp: true,
  port: 443,
  network: 'ws',
  security: 'tls',
  path: '/',
  alpn: 'http/1.1',
  fingerprint: 'chrome',
  flow: '',
  enabled: true,
  subscriptionEligible: true,
  subscriptionHidden: false,
  newUsersOnly: false,
  addToNewClients: true,
  sortOrder: 15,
  // Fragmentation intentionally disabled for this node.
  finalMask: null,
  fragmentation: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const [users, previous] = await Promise.all([listUsers(10000), getServerById(SERVER_ID)]);
const activeUsers = users.filter((user) => user.status !== 'disabled');
const customUsers = activeUsers.filter(
  (user) => user.subscriptionMode === 'custom' && user.customSubscriptionContent?.trim()
);
const rows = activeUsers.map((user) => {
  const before = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const after = [...new Set([...before, SERVER_ID])];
  return { user, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
});

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    serverId: SERVER_ID,
    existingServer: Boolean(previous),
    activeUsers: activeUsers.length,
    usersNeedingAssignment: rows.filter((row) => row.changed).length,
    customSubscriptionsNotRewritten: customUsers.length,
    fragmentation: node.finalMask,
  }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `render-fr1-all-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  server: previous || null,
  users: rows.map(({ user, before }) => ({ id: user.id, bonusServerIds: before })),
}, null, 2), { mode: 0o600 });

await upsertServer(SERVER_ID, { ...node, ...(previous || {}), ...node });
const changed = [];
try {
  for (const row of rows) {
    if (row.changed) {
      await updateUser(row.user.id, { bonusServerIds: row.after, updatedAt: timestamp });
      changed.push(row);
    }
    await upsertUserSubscriptionFile({ ...row.user, bonusServerIds: row.after, updatedAt: timestamp });
  }

  const verification = [];
  for (const row of rows) {
    if (row.user.subscriptionMode === 'custom' && row.user.customSubscriptionContent?.trim()) continue;
    const fresh = await buildUserSubscriptionBody({ ...row.user, bonusServerIds: row.after });
    verification.push({
      id: row.user.id,
      hasNode: fresh.includes(`@${EDGE_IP}:443`) && fresh.includes(HOST),
      hasFinalMask: !fresh.includes('fm='),
    });
  }
  const failed = verification.filter((item) => !item.hasNode || !item.hasFinalMask);
  if (failed.length) throw new Error(`subscription verification failed for ${failed.length} users: ${JSON.stringify(failed.slice(0, 3))}`);

  console.log(JSON.stringify({
    ok: true,
    serverId: SERVER_ID,
    assignedUsers: activeUsers.length,
    changedUsers: changed.length,
    customSubscriptionsNotRewritten: customUsers.length,
    verifiedAutomaticSubscriptions: verification.length,
    nodeScopedFragmentation: false,
    backupPath,
  }, null, 2));
} catch (error) {
  for (const row of changed.reverse()) {
    await updateUser(row.user.id, { bonusServerIds: row.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...row.user, bonusServerIds: row.before, updatedAt: nowIso() }).catch(() => {});
  }
  if (previous) await upsertServer(SERVER_ID, previous).catch(() => {});
  throw new Error(`${error.message}; changes rolled back; backup: ${backupPath}`);
}
