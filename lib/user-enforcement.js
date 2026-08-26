import { getUserById, listUsers, updateUser } from './db-store.js';
import { nowIso } from './dates.js';
import { getTotalUsedGB } from './traffic-usage.js';
import { refreshUserSubscriptionAndEdge } from './user-subscription-file.js';

export function shouldAutoDisable(user, now = Date.now()) {
  if (!user || user.status !== 'active') return null;
  const expiresAt = user.expiresAt ? new Date(user.expiresAt).getTime() : null;
  // Treat the exact expiry instant as expired as well.  Using `<` left a
  // narrow window where a subscription could still be considered active.
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) return 'expired';
  const trafficLimitGB = Number(user.trafficLimitGB);
  if (Number.isFinite(trafficLimitGB) && trafficLimitGB > 0 && getTotalUsedGB(user) >= trafficLimitGB) {
    return 'traffic_exceeded';
  }
  return null;
}

export async function enforceUserLimits(userOrId) {
  const user =
    typeof userOrId === 'string' ? await getUserById(userOrId) : userOrId;
  if (!user) return { changed: false, user: null };

  const reason = shouldAutoDisable(user);
  if (!reason) {
    return { changed: false, user, active: user.status === 'active' };
  }

  await updateUser(user.id, {
    status: 'disabled',
    disabledReason: reason,
    disabledAt: nowIso(),
    updatedAt: nowIso(),
  });

  const updatedUser = {
    ...user,
    status: 'disabled',
    disabledReason: reason,
    disabledAt: nowIso(),
  };

  const { subscriptionFile, vpnEdgeSync } = await refreshUserSubscriptionAndEdge(updatedUser);

  return {
    changed: true,
    user: updatedUser,
    reason,
    active: false,
    subscriptionFile,
    vpnEdgeSync,
  };
}

export async function enforceAllUserLimits() {
  const users = await listUsers();
  const results = [];

  for (const user of users) {
    const result = await enforceUserLimits(user);
    if (result.changed) results.push(result);
  }

  if (results.length) {
    const { scheduleVpnEdgeSync } = await import('./background-sync.js');
    scheduleVpnEdgeSync();
  }

  return {
    checked: users.length,
    disabled: results.length,
    results,
  };
}
