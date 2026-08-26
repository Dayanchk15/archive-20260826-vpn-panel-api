#!/usr/bin/env node
/**
 * Revert GLB pilot: remove Dayanch bonus line, disable glb-vps-1 server.
 * Does NOT delete GCP LB resources (manual). Does NOT touch 7-node pool.
 */
import { listUsers, listServers, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const SERVER_ID = process.env.SERVER_ID || 'glb-vps-1';
const VIP_ID = 'usr_bnjXUy4O1NZufeqW';

const server = (await listServers()).find((s) => s.id === SERVER_ID);
if (server && server.enabled !== false) {
  await upsertServer(SERVER_ID, { enabled: false, updatedAt: nowIso() });
}

const user = (await listUsers()).find((u) => u.id === VIP_ID);
if (user) {
  const bonusServerIds = (user.bonusServerIds || []).filter((id) => id !== SERVER_ID);
  await updateUser(VIP_ID, { bonusServerIds, updatedAt: nowIso() });
  await upsertUserSubscriptionFile({ ...user, bonusServerIds });
}

console.log(JSON.stringify({ ok: true, serverDisabled: SERVER_ID, dayanchLines: 7 }));
