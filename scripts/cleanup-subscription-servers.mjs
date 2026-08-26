import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, listServers, updateServer, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

// Keep only the five lines explicitly requested. Existing VPS services are not
// deleted; they are merely excluded from new/current subscriptions.
const ALLOWED_SERVER_IDS = new Set([
  'cloudflare-fr1-ws-pilot',
  'cloudflare-fr2-ws',
  'cloudflare-fornex-ws',
  'cloudflare-tampa-ws',
  'render-fr1-ws',
]);
const ALLOWED_SERVER_ORDER = [
  'cloudflare-fr1-ws-pilot',
  'cloudflare-fr2-ws',
  'cloudflare-fornex-ws',
  'cloudflare-tampa-ws',
  'render-fr1-ws',
];

const stamp = nowIso().replace(/[:.]/g, '-');
const backupDir = path.resolve('/tmp/maintenance-backups');
await mkdir(backupDir, { recursive: true });
const usersBefore = await listUsers(10000);
const serversBefore = await listServers();
const backupPath = path.join(backupDir, `subscription-cleanup-${stamp}.json`);
await writeFile(backupPath, JSON.stringify({ createdAt: nowIso(), users: usersBefore, servers: serversBefore }, null, 2), { mode: 0o600 });

let serversChanged = 0;
for (const server of serversBefore) {
  const keep = ALLOWED_SERVER_IDS.has(String(server.id));
  if ((server.enabled !== keep) || (server.subscriptionEligible !== keep) || (server.subscriptionHidden === keep) || (server.addToNewClients !== keep)) {
    await updateServer(server.id, {
      enabled: keep,
      subscriptionEligible: keep,
      subscriptionHidden: !keep,
      addToNewClients: keep,
      updatedAt: nowIso(),
    });
    serversChanged += 1;
  }
}

let usersChanged = 0;
let filesRefreshed = 0;
const failures = [];
for (const user of usersBefore) {
  const next = {
    // Relay-only subscriptions are assembled from bonusServerIds. Set the
    // complete allow-list for every user so a user with an empty/old bonus
    // list cannot silently lose one of the five approved lines.
    serverIds: [],
    bonusServerIds: [...ALLOWED_SERVER_ORDER],
    pinnedServerIds: [...ALLOWED_SERVER_ORDER],
    extraSubscriptionLines: [],
    updatedAt: nowIso(),
  };
  await updateUser(user.id, next);
  usersChanged += 1;
  try {
    await upsertUserSubscriptionFile({ ...user, ...next });
    filesRefreshed += 1;
  } catch (error) {
    failures.push({ id: user.id, name: user.name || user.id, error: error.message || String(error) });
  }
}

console.log(JSON.stringify({ ok: failures.length === 0, backupPath, allowedServerIds: [...ALLOWED_SERVER_IDS], serversChanged, usersChanged, filesRefreshed, failures }, null, 2));
