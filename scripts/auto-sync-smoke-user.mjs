#!/usr/bin/env node
/** Create/delete a short-lived client to verify edge-agent pull synchronization. */
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { createUser, listUsers } from '/app/lib/db-store.js';
import { sha256 } from '/app/lib/crypto.js';
import { nowIso } from '/app/lib/dates.js';
import { deleteUserWithData } from '/app/lib/user-delete.js';

const NAME = '__AUTO_SYNC_SMOKE__';
const META = '/tmp/auto-sync-smoke.json';
const action = process.argv[2] || 'create';

if (action === 'create') {
  const existing = (await listUsers(10000)).find((user) => user.name === NAME);
  if (existing) throw new Error('smoke user already exists');
  const uuid = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const timestamp = nowIso();
  const id = await createUser({
    name: NAME,
    uuid,
    subscriptionToken: token,
    tokenHash: sha256(token),
    status: 'active',
    days: 1,
    trafficLimitGB: 1,
    trafficUsedGB: 0,
    serverIds: [],
    bonusServerIds: [],
    pinnedServerIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    autoSyncSmoke: true,
  });
  const targetHash = createHash('sha256').update(uuid.toLowerCase()).digest('hex');
  await writeFile(META, JSON.stringify({ id, uuid, targetHash }), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, action, id, targetHash }));
} else if (action === 'delete') {
  const existing = (await listUsers(10000)).find((user) => user.name === NAME);
  if (existing) await deleteUserWithData(existing.id);
  await rm(META, { force: true });
  console.log(JSON.stringify({ ok: true, action, deleted: Boolean(existing) }));
} else {
  throw new Error('usage: auto-sync-smoke-user.mjs create|delete');
}
