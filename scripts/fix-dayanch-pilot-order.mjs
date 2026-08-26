#!/usr/bin/env node
import { getUserById, updateUser } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { DAYANCH_RELAY_SERVER_IDS, DAYANCH_VIP_USER_ID } from '../lib/vip-users.js';
import { nowIso } from '../lib/dates.js';

const PILOT_IDS = [
  'pilot-tampa-reality',
  'pilot-fornex-reality',
  'pilot-fr1-tcp',
];
const EXPECTED_ADDRESSES = [
  '74.115.172.101:9443',
  '130.17.12.61:443',
  '185.209.230.14:18443',
];
const EXPECTED_TITLES = [
  '🇺🇸 ⭐ USA, Tampa',
  '🇩🇪 ⭐ DE, Frankfurt',
  '🇫🇷 ⭐ FR1, Paris',
];

function parseLines(body) {
  return String(body || '')
    .split('\n')
    .filter((line) => line.startsWith('vless://'));
}

const user = await getUserById(DAYANCH_VIP_USER_ID);
if (!user) throw new Error('Dayanch VIP user not found');

const originalBonusIds = [...(user.bonusServerIds || [])];
const originalPinnedIds = [...(user.pinnedServerIds || [])];
const originalLines = parseLines(await buildUserSubscriptionBody(user));
for (const id of [...DAYANCH_RELAY_SERVER_IDS, ...PILOT_IDS.slice(0, 2)]) {
  if (!originalBonusIds.includes(id)) throw new Error(`Dayanch is missing server: ${id}`);
}

const bonusServerIds = [
  ...PILOT_IDS,
  ...originalBonusIds.filter(
    (id) => !PILOT_IDS.includes(id) && id !== 'pilot-fr2-tcp'
  ),
];
const updatedAt = nowIso();
const pinnedServerIds = [...PILOT_IDS];
const updatedUser = { ...user, bonusServerIds, pinnedServerIds, updatedAt };

try {
  await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt });
  await upsertUserSubscriptionFile(updatedUser);

  const body = await buildUserSubscriptionBody(updatedUser);
  const lines = parseLines(body);
  const firstThree = lines.slice(0, 3).map((line) => {
    const url = new URL(line);
    return {
      address: `${url.hostname}:${url.port}`,
      title: decodeURIComponent(line.split('#')[1] || ''),
      hasServerDescription: line.includes('serverDescription='),
    };
  });

  if (lines.length !== 11) throw new Error(`Expected 11 lines, found ${lines.length}`);
  for (let index = 0; index < 3; index += 1) {
    if (
      firstThree[index]?.address !== EXPECTED_ADDRESSES[index] ||
      firstThree[index]?.title !== EXPECTED_TITLES[index] ||
      firstThree[index]?.hasServerDescription
    ) {
      throw new Error(`Pilot line ${index + 1} format/order verification failed`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        user: { id: user.id, name: user.name },
        previousLines: originalLines.length,
        currentLines: lines.length,
        firstThree,
        otherUsersUpdated: 0,
      },
      null,
      2
    )
  );
} catch (error) {
  const rollbackAt = nowIso();
  const rollbackUser = {
    ...user,
    bonusServerIds: originalBonusIds,
    pinnedServerIds: originalPinnedIds,
    updatedAt: rollbackAt,
  };
  await updateUser(user.id, {
    bonusServerIds: originalBonusIds,
    pinnedServerIds: originalPinnedIds,
    updatedAt: rollbackAt,
  });
  await upsertUserSubscriptionFile(rollbackUser);
  throw error;
}
