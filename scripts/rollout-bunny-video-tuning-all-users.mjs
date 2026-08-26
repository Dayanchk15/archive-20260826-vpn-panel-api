#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteServer,
  getServerById,
  listUsers,
  updateUser,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { nowIso } from '/app/lib/dates.js';
import { isUserActive } from '/app/lib/active-users.js';

const APPLY = process.argv.includes('--apply');
const VIDEO_PILOT_ID = 'bunny-az-fr2-video-pilot';
const targets = [
  { id: 'bunny-az-fr2-pilot', host: 'levospeedfr2.b-cdn.net', path: '/bunny/fr2?ed=2560' },
  { id: 'bunny-az-fornex-pilot', host: 'levospeedfornex.b-cdn.net', path: '/assets/v3/sync?ed=2560' },
  { id: 'bunny-az-tampa-pilot', host: 'levospeedtampa.b-cdn.net', path: '/bunny/tampa?ed=2560' },
];
const targetIds = targets.map((item) => item.id);
const targetHosts = new Set(targets.map((item) => item.host));

function withoutPilot(values) {
  return (Array.isArray(values) ? values.map(String) : []).filter((id) => id !== VIDEO_PILOT_ID);
}

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function vlessLines(body) {
  return String(body || '').split('\n').filter((line) => line.startsWith('vless://'));
}

function connectionPart(line) {
  return String(line || '').split('#')[0];
}

function hostOf(line) {
  try { return new URL(line).searchParams.get('host') || ''; } catch { return ''; }
}

const users = (await listUsers(10000)).filter((user) => user.uuid);
if (!users.length) throw new Error('No users with UUID found');
const customAssigned = users.filter((user) =>
  user.subscriptionMode === 'custom' &&
  [...(user.serverIds || []), ...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])]
    .map(String)
    .some((id) => targetIds.includes(id))
);
if (customAssigned.length) throw new Error(`Custom assigned users require manual handling: ${customAssigned.length}`);

const previousServers = new Map();
for (const id of [...targetIds, VIDEO_PILOT_ID]) previousServers.set(id, await getServerById(id));
for (const id of targetIds) {
  const server = previousServers.get(id);
  if (!server || server.enabled === false) throw new Error(`Active Bunny server missing: ${id}`);
}

const changes = [];
for (const user of users) {
  const before = {
    serverIds: Array.isArray(user.serverIds) ? user.serverIds.map(String) : [],
    bonusServerIds: Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [],
    pinnedServerIds: Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [],
  };
  changes.push({
    user,
    before,
    after: {
      serverIds: withoutPilot(before.serverIds),
      bonusServerIds: withoutPilot(before.bonusServerIds),
      pinnedServerIds: withoutPilot(before.pinnedServerIds),
    },
    oldBody: await buildUserSubscriptionBody(user),
  });
}

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    users: users.length,
    targets,
    rejectUdp443: true,
    removeDuplicatePilotAssignments: changes.filter((change) =>
      [...change.before.serverIds, ...change.before.bonusServerIds, ...change.before.pinnedServerIds]
        .includes(VIDEO_PILOT_ID)
    ).length,
  }, null, 2));
  process.exit(0);
}

const timestamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `bunny-video-all-${timestamp.replace(/[:.]/g, '-')}.json`);
await writeFile(backupPath, JSON.stringify({
  createdAt: timestamp,
  previousServers: Object.fromEntries(previousServers),
  users: changes.map(({ user, before }) => ({ id: user.id, name: user.name, before })),
}, null, 2), 'utf8');

let serversApplied = false;
const appliedUsers = [];
async function rollback() {
  for (const [id, previous] of previousServers) {
    if (previous) await upsertServer(id, previous).catch(() => {});
    else await deleteServer(id).catch(() => {});
  }
  if (serversApplied) {
    for (const change of [...appliedUsers].reverse()) {
      const restored = { ...change.user, ...change.before, updatedAt: nowIso() };
      await updateUser(change.user.id, { ...change.before, updatedAt: restored.updatedAt }).catch(() => {});
      await upsertUserSubscriptionFile(restored).catch(() => {});
    }
  }
}

try {
  for (const target of targets) {
    const previous = previousServers.get(target.id);
    await upsertServer(target.id, {
      ...previous,
      path: target.path,
      rejectUdp443: true,
      enabled: true,
      addToNewClients: true,
      updatedAt: timestamp,
    });
  }
  if (previousServers.get(VIDEO_PILOT_ID)) await deleteServer(VIDEO_PILOT_ID);
  serversApplied = true;

  for (const change of changes) {
    const previewUser = { ...change.user, ...change.after };
    const body = await buildUserSubscriptionBody(previewUser);
    const lines = vlessLines(body);
    for (const target of targets) {
      const matching = lines.filter((line) => hostOf(line) === target.host);
      if (matching.length !== 1) throw new Error(`${change.user.id}: ${target.host} count=${matching.length}`);
      const url = new URL(matching[0]);
      if (url.hostname !== '94.20.154.22') throw new Error(`${change.user.id}: wrong Bunny edge IP`);
      if (url.searchParams.get('path') !== target.path) throw new Error(`${change.user.id}: wrong path for ${target.host}`);
      if (url.searchParams.get('xudpProxyUDP443') !== 'reject') {
        throw new Error(`${change.user.id}: UDP/443 is not rejected for ${target.host}`);
      }
    }
    const oldUnrelated = vlessLines(change.oldBody)
      .filter((line) => !targetHosts.has(hostOf(line)))
      .filter((line) => hostOf(line) !== 'levospeedfr2.b-cdn.net' || !line.includes('ed%3D2560'))
      .map(connectionPart);
    const newConnections = new Set(lines.map(connectionPart));
    const lost = oldUnrelated.filter((line) => !newConnections.has(line));
    if (lost.length) throw new Error(`${change.user.id}: lost ${lost.length} unrelated line(s)`);
  }

  for (const change of changes) {
    const updatedAt = nowIso();
    await updateUser(change.user.id, { ...change.after, updatedAt });
    appliedUsers.push(change);
    await upsertUserSubscriptionFile({ ...change.user, ...change.after, updatedAt });
  }

  const finalUsers = (await listUsers(10000)).filter((user) => user.uuid);
  for (const user of finalUsers) {
    const generated = await buildUserSubscriptionBody(user);
    const stored = plainContent((await getFileByLinkedUserId(user.id))?.content);
    const bodiesToVerify = [['generated', generated]];
    if (isUserActive(user)) bodiesToVerify.push(['stored', stored]);
    for (const [label, body] of bodiesToVerify) {
      const lines = vlessLines(body);
      for (const target of targets) {
        const matching = lines.filter((line) => hostOf(line) === target.host);
        if (matching.length !== 1) throw new Error(`${user.id}: ${label} ${target.host} count=${matching.length}`);
        const url = new URL(matching[0]);
        if (url.searchParams.get('path') !== target.path ||
            url.searchParams.get('xudpProxyUDP443') !== 'reject') {
          throw new Error(`${user.id}: ${label} tuning mismatch for ${target.host}`);
        }
      }
    }
    if ([...(user.serverIds || []), ...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])]
      .map(String).includes(VIDEO_PILOT_ID)) {
      throw new Error(`${user.id}: duplicate video pilot assignment remains`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    usersUpdated: appliedUsers.length,
    bunnyServersUpdated: targetIds,
    earlyData: 2560,
    rejectUdp443: true,
    duplicatePilotRemoved: true,
    backupPath,
  }, null, 2));
} catch (error) {
  await rollback();
  throw new Error(`${error.message}; rolled back; backup: ${backupPath}`);
}
