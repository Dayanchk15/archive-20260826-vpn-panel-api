#!/usr/bin/env node
/** Rename gcp2-eu-de3 / 162.217.248.32 display to USA; refresh Test_GCP2_Opt only. */
import { getServerById, listUsers, updateServer, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const SERVER_ID = 'gcp2-eu-de3';
const patch = {
  name: 'USA (GCP2)',
  country: 'USA',
  flag: '🇺🇸',
  updatedAt: nowIso(),
};

const server = await getServerById(SERVER_ID);
if (!server) throw new Error(`Server not found: ${SERVER_ID}`);
await updateServer(SERVER_ID, patch);

const testUser = (await listUsers(5000)).find((u) => u.gcp2TestUser || u.name === 'Test_GCP2_Opt');
if (testUser) {
  await upsertUserSubscriptionFile(testUser);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      serverId: SERVER_ID,
      ip: server.addressIp || '162.217.248.32',
      before: { name: server.name, country: server.country, flag: server.flag },
      after: patch,
      testUserRefreshed: Boolean(testUser),
    },
    null,
    2
  )
);
