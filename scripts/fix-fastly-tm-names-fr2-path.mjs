#!/usr/bin/env node
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.argv.includes('--apply');
const updates = [
  { id: 'tm-tampa-fastly-h3', name: 'США', country: 'США', flag: '🇺🇸', path: '/tampa/' },
  { id: 'tm-fornex-fastly-h3', name: 'Германия', country: 'Германия', flag: '🇩🇪', path: '/fornex/' },
  { id: 'tm-fr2-fastly-h3', name: 'Франция', country: 'Франция', flag: '🇫🇷', path: '/fr2/' },
];

const before = [];
for (const update of updates) {
  const existing = await getServerById(update.id);
  if (!existing) throw new Error(`Missing existing server ${update.id}`);
  before.push(existing);
  await upsertServer(update.id, {
    ...existing,
    ...update,
    addToNewClients: false,
    subscriptionEligible: true,
    updatedAt: nowIso(),
  });
}

const users = (await listUsers(10000)).filter((user) => user.uuid);
const assignedUsers = users.filter((user) =>
  updates.some(({ id }) => user.bonusServerIds?.includes(id) || user.pinnedServerIds?.includes(id))
);
const failures = [];
for (const user of assignedUsers) {
  const body = await buildUserSubscriptionBody(user);
  const required = [
    '%F0%9F%87%BA%F0%9F%87%B8%20%D0%A1%D0%A8%D0%90',
    '%F0%9F%87%A9%F0%9F%87%AA%20%D0%93%D0%B5%D1%80%D0%BC%D0%B0%D0%BD%D0%B8%D1%8F',
    '%F0%9F%87%AB%F0%9F%87%B7%20%D0%A4%D1%80%D0%B0%D0%BD%D1%86%D0%B8%D1%8F',
    'path=%2Ffr2%2F',
  ];
  const missing = required.filter((value) => !body.includes(value));
  if (missing.length) {
    const tmLines = body
      .split('\n')
      .filter((line) => line.includes('@199.232.247.142:443'))
      .map((line) => line.replace(/^vless:\/\/[^@]+@/, 'vless://UUID@'));
    failures.push({ userId: user.id, missing, tmLines });
  }
}

if (failures.length || !APPLY) {
  if (!APPLY) {
    for (const server of before) await upsertServer(server.id, server);
    console.log(JSON.stringify({ ok: !failures.length, dryRun: true, assignedUsers: assignedUsers.length, failures: failures.slice(0, 5) }, null, 2));
    if (failures.length) process.exitCode = 1;
    process.exit();
  }
  throw new Error(`Fastly rename/path validation failed: ${JSON.stringify(failures.slice(0, 5))}`);
}

for (const user of assignedUsers) await upsertUserSubscriptionFile(user);
console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  assignedUsers: assignedUsers.length,
  userAssignmentsChanged: 0,
  addToNewClients: false,
  fr2Path: '/fr2/',
}, null, 2));
