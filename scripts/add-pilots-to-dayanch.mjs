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
const PILOT_ADDRESSES = [
  '74.115.172.101:9443',
  '130.17.12.61:443',
  '185.209.230.14:18443',
];

const user = await getUserById(DAYANCH_VIP_USER_ID);
if (!user) throw new Error('Dayanch VIP user not found');

const originalBonusIds = [...(user.bonusServerIds || [])];
for (const requiredId of DAYANCH_RELAY_SERVER_IDS) {
  if (!originalBonusIds.includes(requiredId)) {
    throw new Error(`Dayanch is missing required existing server: ${requiredId}`);
  }
}

const originalBody = await buildUserSubscriptionBody(user);
const originalLines = originalBody.split('\n').filter((line) => line.startsWith('vless://'));
if (originalLines.length !== 8) {
  throw new Error(`Expected Dayanch to have 8 lines before update, found ${originalLines.length}`);
}

const bonusServerIds = [...new Set([...originalBonusIds, ...PILOT_IDS])];
const updatedAt = nowIso();
const updatedUser = {
  ...user,
  bonusServerIds,
  updatedAt,
};

try {
  await updateUser(user.id, { bonusServerIds, updatedAt });
  await upsertUserSubscriptionFile(updatedUser);

  const body = await buildUserSubscriptionBody(updatedUser);
  const lines = body.split('\n').filter((line) => line.startsWith('vless://'));
  const missingAddresses = PILOT_ADDRESSES.filter(
    (address) => !body.includes(`@${address}`)
  );
  if (lines.length !== 11 || missingAddresses.length) {
    throw new Error(
      `Dayanch verification failed: lines=${lines.length}, missing=${missingAddresses.join(',')}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        user: { id: user.id, name: user.name },
        previousLines: originalLines.length,
        currentLines: lines.length,
        retainedExistingServers: DAYANCH_RELAY_SERVER_IDS.length,
        addedPilots: PILOT_IDS,
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
    updatedAt: rollbackAt,
  };
  await updateUser(user.id, {
    bonusServerIds: originalBonusIds,
    updatedAt: rollbackAt,
  });
  await upsertUserSubscriptionFile(rollbackUser);
  throw error;
}
