#!/usr/bin/env node
import { listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { isUserActive } from '/app/lib/active-users.js';

const CF_IDS = [
  'cloudflare-finalmask-tampa-dayanch',
  'cloudflare-finalmask-fr1-dayanch',
  'cloudflare-finalmask-fornex-dayanch',
  'cloudflare-fr2-finalmask-dayanch',
];
const CF_HOSTS = ['tampa.levospeed.click', 'fr1.levospeed.click', 'fornex.levospeed.click', 'fr2.levospeed.click'];
const BUNNY_IDS = ['bunny-az-fr2-pilot', 'bunny-az-fornex-pilot', 'bunny-az-tampa-pilot', 'bunny-az-fr1-pilot'];

const users = (await listUsers(10000)).filter((user) => user.uuid);
const failures = [];
let activeVerified = 0;
for (const user of users) {
  const assigned = new Set([...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])].map(String));
  const missingIds = [...CF_IDS, ...BUNNY_IDS].filter((id) => !assigned.has(id));
  if (missingIds.length) failures.push({ id: user.id, issue: `missing assignments: ${missingIds.length}` });
  if (!isUserActive(user)) continue;
  const generated = await buildUserSubscriptionBody(user);
  const file = await getFileByLinkedUserId(user.id);
  const stored = String(file?.content || '');
  const missingGenerated = CF_HOSTS.filter((host) => !generated.includes(`host=${host}`));
  const missingStored = CF_HOSTS.filter((host) => !stored.includes(`host=${host}`));
  if (missingGenerated.length || missingStored.length) {
    failures.push({ id: user.id, issue: `generated=${missingGenerated.length},stored=${missingStored.length}` });
  } else {
    activeVerified += 1;
  }
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  usersAssigned: users.length,
  activeSubscriptionsVerified: activeVerified,
  failures: failures.length,
  sampleFailures: failures.slice(0, 3),
}, null, 2));
if (failures.length) process.exitCode = 1;
