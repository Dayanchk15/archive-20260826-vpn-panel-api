import { findUserByTokenHash } from './db-store.js';
import { sha256 } from './crypto.js';
import { getUserById } from './db-store.js';
import { enforceUserLimits } from './user-enforcement.js';

export async function findUserBySubscriptionToken(token) {
  const tokenHash = sha256(token);
  const user = await findUserByTokenHash(tokenHash);
  if (user) return user;

  if (/^[a-f0-9]{64}$/i.test(token)) {
    return findUserByTokenHash(token);
  }

  return null;
}

export async function prepareUserForSubscription(token) {
  const user = await findUserBySubscriptionToken(token);
  if (!user) return null;

  const enforcement = await enforceUserLimits(user);
  if (enforcement.changed) {
    return (await getUserById(user.id)) || enforcement.user || user;
  }

  return user;
}
