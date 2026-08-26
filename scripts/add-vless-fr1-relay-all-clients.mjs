#!/usr/bin/env node
/** Register the isolated VLESS ingress and assign it to every active user. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, getServerById, upsertServer, updateUser } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const SERVER_ID = process.env.SERVER_ID || 'vless-tcp-fr1-relay-19323321753';
const HOST = process.env.SERVER_HOST || '193.233.217.53';
const PORT = Number(process.env.SERVER_PORT || 18443);
const UUID = process.env.SERVER_UUID || '46ccec06-619f-4d69-8c34-0f8939c92b58';
const NODE_ID = process.env.TRAFFIC_NODE_ID || SERVER_ID;
const PUBLISH_SS = process.argv.includes('--publish-ss');
const SS_LINK = String(process.env.SS_LINK || '').trim();
const timestamp = nowIso();

const node = {
  id: SERVER_ID,
  service: SERVER_ID,
  name: 'FR1 Relay',
  country: 'France, Paris',
  region: 'France',
  flag: '🇫🇷',
  host: HOST,
  addressIp: HOST,
  addressIps: [HOST],
  forceAddressIp: true,
  strictAddressIp: true,
  port: PORT,
  protocol: 'vless',
  network: 'tcp',
  security: 'none',
  flow: '',
  enabled: true,
  subscriptionEligible: true,
  subscriptionHidden: false,
  newUsersOnly: false,
  addToNewClients: true,
  externalVps: true,
  standalonePilot: true,
  trafficReporter: true,
  trafficNodeId: NODE_ID,
  sortOrder: 480,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const [users, previous, panelBefore] = await Promise.all([listUsers(10000), getServerById(SERVER_ID), getPanelSettings()]);
const active = users.filter((user) => user.status !== 'disabled');
const rows = active.map((user) => {
  const before = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const after = [...new Set([...before, SERVER_ID])];
  return { user, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), custom: user.subscriptionMode === 'custom' && user.customSubscriptionContent?.trim() };
});

if (!APPLY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, serverId: SERVER_ID, activeUsers: active.length, usersNeedingAssignment: rows.filter((r) => r.changed).length, customSubscriptions: rows.filter((r) => r.custom).length, publishSs: PUBLISH_SS && Boolean(SS_LINK) }, null, 2));
  process.exit(0);
}

const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `vless-fr1-relay-all-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, server: previous || null, users: rows.map(({ user, before }) => ({ id: user.id, bonusServerIds: before })) }, null, 2), { mode: 0o600 });

await upsertServer(SERVER_ID, { ...node, ...(previous || {}), ...node });
const changed = [];
try {
  if (PUBLISH_SS && SS_LINK) {
    const currentLines = Array.isArray(panelBefore.globalExtraSubscriptionLines) ? panelBefore.globalExtraSubscriptionLines.map(String) : [];
    if (!currentLines.includes(SS_LINK)) {
      await updatePanelSettings({ globalExtraSubscriptionLines: [...currentLines, SS_LINK] });
    }
  }
  for (const row of rows) {
    if (row.changed) {
      await updateUser(row.user.id, { bonusServerIds: row.after, updatedAt: timestamp });
      changed.push(row);
    }
    await upsertUserSubscriptionFile({ ...row.user, bonusServerIds: row.after, updatedAt: timestamp });
  }
  const failures = [];
  let verified = 0;
  for (const row of rows) {
    if (row.custom) continue;
    const body = await buildUserSubscriptionBody({ ...row.user, bonusServerIds: row.after });
    if (!body.includes(`@${HOST}:${PORT}`) || !body.includes('type=tcp')) failures.push(row.user.id);
    else verified += 1;
  }
  if (failures.length) throw new Error(`subscription verification failed for ${failures.length} users: ${failures.slice(0, 5).join(',')}`);
  console.log(JSON.stringify({ ok: true, serverId: SERVER_ID, trafficNodeId: NODE_ID, assignedUsers: active.length, changedUsers: changed.length, verifiedAutomaticSubscriptions: verified, customSubscriptionsNotRewritten: rows.filter((r) => r.custom).length, ssPublished: PUBLISH_SS && Boolean(SS_LINK), backupPath }, null, 2));
} catch (error) {
  for (const row of changed.reverse()) {
    await updateUser(row.user.id, { bonusServerIds: row.before, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...row.user, bonusServerIds: row.before, updatedAt: nowIso() }).catch(() => {});
  }
  if (previous) await upsertServer(SERVER_ID, previous).catch(() => {});
  if (PUBLISH_SS && SS_LINK) await updatePanelSettings({ globalExtraSubscriptionLines: panelBefore.globalExtraSubscriptionLines || [] }).catch(() => {});
  throw new Error(`${error.message}; changes rolled back; backup: ${backupPath}`);
}
