import { randomToken, sha256 } from './crypto.js';
import { getUserById, updateUser } from './db-store.js';
import { nowIso } from './dates.js';

/** Plaintext token for /api/sub/:token — only stored when created; never rotate existing hash. */
export async function ensureUserSubscriptionToken(user) {
  const id = user?.id;
  if (!id) {
    throw new Error('user.id is required');
  }

  const existing = String(user.subscriptionToken || '').trim();
  if (existing) {
    const expected = sha256(existing);
    if (!user.tokenHash || user.tokenHash === expected) {
      return existing;
    }
    // Stale plaintext in DB — original /api/sub/{token} still uses tokenHash
  }

  if (user.tokenHash) {
    return null;
  }

  const token = randomToken();
  const tokenHash = sha256(token);
  await updateUser(id, {
    subscriptionToken: token,
    tokenHash,
    updatedAt: nowIso(),
  });

  return token;
}

/**
 * When plaintext token was cleared (e.g. hash restore) but import uses /api/sub/,
 * mint a new token so the panel can show the correct Happ import URL.
 */
export async function issueSubscriptionTokenIfMissing(user) {
  const id = user?.id;
  if (!id) {
    throw new Error('user.id is required');
  }

  const existing = String(user.subscriptionToken || '').trim();
  if (existing) {
    const expected = sha256(existing);
    if (!user.tokenHash || user.tokenHash === expected) {
      return { token: existing, rotated: false, user };
    }
  }

  const token = randomToken();
  const tokenHash = sha256(token);
  await updateUser(id, {
    subscriptionToken: token,
    tokenHash,
    happEncryptedUrl: null,
    updatedAt: nowIso(),
  });

  const refreshed = await getUserById(id);
  return { token, rotated: true, user: refreshed || { ...user, subscriptionToken: token, tokenHash } };
}

export async function ensureUserSubscriptionTokenById(userId) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  const token = await ensureUserSubscriptionToken(user);
  return { user: { ...user, subscriptionToken: token }, token };
}
