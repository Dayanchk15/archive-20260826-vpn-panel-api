import { getUserById, updateUser } from './db-store.js';
import { addDays, nowIso } from './dates.js';
import { resetTrafficUsage } from './traffic-usage.js';
import { refreshUserSubscriptionAndEdge } from './user-subscription-file.js';

export function resolveResetPeriodDays(user, overrideDays) {
  if (Number.isFinite(Number(overrideDays)) && Number(overrideDays) > 0) {
    return Math.floor(Number(overrideDays));
  }

  if (Number.isFinite(Number(user?.subscriptionPeriodDays)) && Number(user.subscriptionPeriodDays) > 0) {
    return Math.floor(Number(user.subscriptionPeriodDays));
  }

  const periodStart = user?.periodStartedAt || user?.createdAt;
  if (periodStart && user?.expiresAt) {
    const days = Math.ceil(
      (new Date(user.expiresAt).getTime() - new Date(periodStart).getTime()) / 86400000
    );
    if (days > 0) return days;
  }
  return 30;
}

export function resolveResetExpiry(user, overrideDays, resetAt = new Date()) {
  const periodDays = resolveResetPeriodDays(user, overrideDays);
  return {
    expiresAt: addDays(resetAt, periodDays).toISOString(),
    expiresAtUnchanged: false,
  };
}

export async function resetUserUsage(user, options = {}) {
  if (!user?.id) throw new Error('User not found');

  await resetTrafficUsage(user.id);

  const periodDays = resolveResetPeriodDays(user, options.days);
  const resetAt = new Date();
  const expiry = resolveResetExpiry(user, options.days, resetAt);
  const update = {
    uploadUsedGB: 0,
    downloadUsedGB: 0,
    trafficUsedGB: 0,
    subscriptionPeriodDays: periodDays,
    periodStartedAt: resetAt.toISOString(),
    usageResetAt: resetAt.toISOString(),
    expiresAt: expiry.expiresAt,
    updatedAt: nowIso(),
  };

  if (['traffic_exceeded', 'expired'].includes(String(user.disabledReason || ''))) {
    update.status = 'active';
    update.disabledReason = null;
    update.disabledAt = null;
  }

  await updateUser(user.id, update);
  const refreshed = await getUserById(user.id);
  const { subscriptionFile, vpnEdgeSync } = await refreshUserSubscriptionAndEdge(refreshed);
  const remainingDays = Math.max(0, Math.ceil((new Date(expiry.expiresAt).getTime() - resetAt.getTime()) / 86400000));
  return {
    user: refreshed,
    subscriptionFile,
    vpnEdgeSync,
    periodDays,
    remainingDays,
    expiresAtUnchanged: expiry.expiresAtUnchanged,
  };
}
